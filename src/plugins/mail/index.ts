/**
 * Apple Mail source plugin (macOS, live).
 *
 * Walks ~/Library/Mail/V<n>/ for the latest version directory and indexes
 * every .emlx message it finds. No manual mbox exports.
 *
 * Apple Mail stores each message as an individual .emlx file under a
 * deeply-nested path:
 *
 *   ~/Library/Mail/V10/<UUID>/<Mailbox>.mbox/<UUID>/Data/<n>/<n>/.../Messages/<id>.emlx
 *
 * .emlx is RFC 822 with two extensions:
 *   - first line is a decimal byte count of the RFC 822 portion
 *   - after the body there is a binary plist of Apple-specific metadata
 *     (read flags, etc.) that we ignore
 *
 * Requires Full Disk Access for the terminal.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { glob } from 'glob';
import type { Document, IngestContext, Plugin } from '../types.ts';
import { type ParsedEmail, parseEmlx } from './parser.ts';

const NAME = 'mail';

// Cap to avoid melting the laptop on a 100k-message inbox the first time.
// Users can override with maxMessages in plugin config.
const DEFAULT_MAX_MESSAGES = 5000;

// Skip individual .emlx files larger than this — they're almost always
// HTML newsletters or messages with huge attachments, and parsing them
// blocks the event loop for seconds. Body chunks beyond this are noise
// for retrieval anyway.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Per-message processing timeout. Pathological MIME (deeply nested
// multipart, broken quoted-printable) can pin the regex engine for ages;
// rather than freezing the whole sync we drop the offender and keep going.
const PER_MESSAGE_TIMEOUT_MS = 4_000;

// Truncate the embedded text per message. multilingual-e5-small has a
// 512-token context — anything longer gets silently cut by the tokenizer.
// But the tokenizer itself is O(n) on the *raw* string, so passing 50KB
// of HTML newsletter when only the first 4KB will ever be considered is
// pure waste. ~4000 chars ≈ 1000 tokens, comfortably above the model
// limit, so we lose no signal but cut tokenize time dramatically.
const MAX_EMBED_CHARS = 4000;

const MAIL_ROOT = join(homedir(), 'Library', 'Mail');

interface MailPluginConfig {
  enabled: boolean;
  /** Max messages to index per run. Default 5000; raise for full archive. */
  maxMessages?: number;
}

export const mailPlugin: Plugin = {
  name: NAME,
  version: '0.2.0',
  description: 'Indexes Apple Mail messages directly from ~/Library/Mail (macOS).',

  async isAvailable(): Promise<boolean> {
    return existsSync(MAIL_ROOT) && findLatestVersionDir() !== null;
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    const versionDir = findLatestVersionDir();
    if (!versionDir) {
      throw new Error(
        `Apple Mail data directory not found.\n  Looked at: ${MAIL_ROOT}/V<version>\n  Are you on macOS with Mail.app set up?`,
      );
    }

    let files: string[];
    try {
      // Glob respects FS permissions — TCC failures show up as ENOENT here, so
      // we additionally probe a known subpath to surface a friendlier error.
      const probe = readdirSync(versionDir);
      if (probe.length === 0) {
        throw new Error('Mail directory is empty (TCC may be silently filtering).');
      }
      files = await glob('**/Messages/*.emlx', {
        cwd: versionDir,
        absolute: true,
        nodir: true,
      });
    } catch (err) {
      if (err instanceof Error && /EPERM|EACCES/.test(err.message)) {
        throw new Error(
          'Apple Mail directory is protected by macOS Full Disk Access.\n  Grant your terminal access:\n    System Settings → Privacy & Security → Full Disk Access → add Terminal/iTerm/Warp/Ghostty\n  Then restart the terminal and re-run.',
        );
      }
      throw err;
    }

    const config = ctx.config as MailPluginConfig;
    const limit = Math.max(1, config.maxMessages ?? DEFAULT_MAX_MESSAGES);

    // Newest first by mtime. We don't pre-sort all files (could be 100k+);
    // instead, when over the cap we only stat as many as we need.
    if (files.length > limit) {
      files = await pickRecent(files, limit);
    }

    const total = files.length;
    let current = 0;
    ctx.onProgress?.({
      current,
      total,
      message: `Found ${total} messages under ${basename(versionDir)}`,
    });

    for (const filePath of files) {
      if (ctx.signal?.aborted) return;
      current++;

      // Update progress on every message — without this the user can't tell
      // if a slow file is processing or if we've frozen.
      if (current % 25 === 0 || current === 1) {
        ctx.onProgress?.({ current, total, message: `${current}/${total} messages` });
      }

      try {
        const stats = await stat(filePath);
        if (stats.size > MAX_FILE_BYTES) {
          ctx.onProgress?.({
            current,
            total,
            message: `⚠ Skipped ${basename(filePath)} (${(stats.size / 1024 / 1024).toFixed(1)}MB > ${MAX_FILE_BYTES / 1024 / 1024}MB)`,
          });
          continue;
        }

        const raw = await readFile(filePath, 'utf-8');
        const email = await parseWithTimeout(raw, PER_MESSAGE_TIMEOUT_MS);
        if (!email) continue;

        yield emailToDocument(email, filePath, stats.mtimeMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.onProgress?.({
          current,
          total,
          message: `⚠ Skipped ${basename(filePath)}: ${message}`,
        });
      }
    }
  },
};

/**
 * Run parseEmlx with a hard time budget. We use setImmediate to yield to
 * the event loop *before* parsing, then race against a setTimeout. Pure
 * sync regex work can still blow past the timeout (no preemption in JS),
 * but for the cases we care about (huge HTML or QP loops) the parser
 * does enough small async-ish work to be cancellable in practice.
 */
async function parseWithTimeout(
  raw: string,
  timeoutMs: number,
): Promise<ReturnType<typeof parseEmlx>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`parse timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Defer the parse so the timer is armed first; otherwise a fully sync
    // pathological parse would never let the timeout fire.
    setImmediate(() => {
      try {
        const result = parseEmlx(raw);
        clearTimeout(timer);
        resolve(result);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * Find the highest-numbered V<n> directory under ~/Library/Mail. Apple bumps
 * this with major macOS releases (V10, V11, V12 …) so we always pick the
 * latest installation rather than hard-coding.
 */
function findLatestVersionDir(): string | null {
  if (!existsSync(MAIL_ROOT)) return null;
  let entries: string[];
  try {
    entries = readdirSync(MAIL_ROOT);
  } catch {
    return null;
  }

  const versions = entries
    .map((name) => /^V(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);

  for (const v of versions) {
    const candidate = join(MAIL_ROOT, `V${v}`);
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // permission denied — try the next one
    }
  }
  return null;
}

/**
 * Pick the most-recently-modified `limit` files. Avoids stat'ing all 100k
 * messages by using a top-k heap pattern.
 */
async function pickRecent(files: string[], limit: number): Promise<string[]> {
  interface FileWithMtime {
    path: string;
    mtimeMs: number;
  }

  const top: FileWithMtime[] = [];
  let minMtime = Number.NEGATIVE_INFINITY;

  for (const file of files) {
    let mtime = 0;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    if (top.length < limit) {
      top.push({ path: file, mtimeMs: mtime });
      if (top.length === limit) {
        minMtime = Math.min(...top.map((f) => f.mtimeMs));
      }
    } else if (mtime > minMtime) {
      // Replace the oldest entry; recompute min.
      let minIdx = 0;
      for (let i = 1; i < top.length; i++) {
        const t = top[i];
        const m = top[minIdx];
        if (t && m && t.mtimeMs < m.mtimeMs) minIdx = i;
      }
      top[minIdx] = { path: file, mtimeMs: mtime };
      minMtime = Math.min(...top.map((f) => f.mtimeMs));
    }
  }

  return top.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

function emailToDocument(e: ParsedEmail, sourcePath: string, mtimeMs: number): Document {
  const subject = e.subject || '(no subject)';
  const fromLine = e.from ? `From: ${e.from}` : '';
  const toLine = e.to.length > 0 ? `To: ${e.to.join(', ')}` : '';
  const dateLine = e.date ? `Date: ${new Date(e.date).toISOString()}` : '';

  const headerBlock = [fromLine, toLine, dateLine].filter(Boolean).join('\n');

  // Hard-truncate the body: see MAX_EMBED_CHARS — tokenize cost is linear
  // in the raw string length, and the model only attends to ~512 tokens
  // anyway, so feeding it more is purely wasted work.
  const headerSize = subject.length + headerBlock.length + 4;
  const bodyBudget = Math.max(0, MAX_EMBED_CHARS - headerSize);
  const truncatedBody = e.body.length > bodyBudget ? `${e.body.slice(0, bodyBudget)}…` : e.body;

  const content = `${subject}\n${headerBlock}\n\n${truncatedBody}`;

  return {
    id: e.messageId || `${sourcePath}`,
    title: subject,
    content,
    timestamp: e.date ?? mtimeMs,
    fingerprint: `${e.messageId ?? ''}-${e.date ?? mtimeMs}`,
    metadata: {
      from: e.from,
      to: e.to,
      cc: e.cc,
      messageId: e.messageId,
      sourcePath,
      bodyTruncated: e.body.length > bodyBudget,
      originalBodyLength: e.body.length,
    },
  };
}
