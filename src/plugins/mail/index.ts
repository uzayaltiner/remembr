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
import type { Document, IngestContext, Plugin } from '../types.js';
import { type ParsedEmail, parseEmlx } from './parser.js';

const NAME = 'mail';

// Cap to avoid melting the laptop on a 100k-message inbox the first time.
// Users can override with maxMessages in plugin config. 2000 messages on
// M-series silicon takes ~90s on first sync; raising to 5000 was the old
// default but makes the demo painful.
const DEFAULT_MAX_MESSAGES = 2000;

// Default lookback in days. Apple Mail archives often go back a decade —
// the bulk of useful retrieval is the last year. Override with `maxAgeDays`.
const DEFAULT_MAX_AGE_DAYS = 365;

// Folders we never index. They are loud, low-signal, and the user never
// asks "what did I write in Junk a year ago?".
const SKIP_FOLDER_PATTERNS = [
  /\/(?:Junk|Spam|Trash|Deleted Items|Deleted Messages)\.mbox\//i,
  /\/Junk Mail\.mbox\//i,
  /\/Drafts\.mbox\//i,
];

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
  /** Max messages to index per run. Default 2000; raise for full archive. */
  maxMessages?: number;
  /** Skip messages older than this many days. Default 365. Set 0 to disable. */
  maxAgeDays?: number;
}

export const mailPlugin: Plugin = {
  name: NAME,
  version: '0.2.0',
  description: 'Indexes Apple Mail messages directly from ~/Library/Mail (macOS).',

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
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
      // Drop noisy folders before we ever stat them.
      const before = files.length;
      files = files.filter((f) => !SKIP_FOLDER_PATTERNS.some((re) => re.test(f)));
      if (before !== files.length) {
        ctx.onProgress?.({
          current: 0,
          total: 0,
          message: `Skipped ${before - files.length} messages in Junk/Trash/Drafts`,
        });
      }
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
    const maxAgeDays = config.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    const minMtime = maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : 0;

    // pickRecent takes newest by mtime. When a date floor is set we filter
    // there to avoid stat'ing files we're going to throw away anyway.
    files = await pickRecentSince(files, limit, minMtime);

    const total = files.length;
    let current = 0;
    ctx.onProgress?.({
      current,
      total,
      message: `Found ${total} messages under ${basename(versionDir)}`,
    });

    // Read CONCURRENCY files in parallel; APFS can serve multiple small
    // reads at once, and parseWithTimeout schedules its work via
    // setImmediate so several parses can interleave with the I/O. Yields
    // are still ordered (we await Promise.all on each batch) so the
    // downstream embedding pipeline keeps its document order.
    for (let i = 0; i < files.length; i += FILE_READ_CONCURRENCY) {
      if (ctx.signal?.aborted) return;
      const batch = files.slice(i, i + FILE_READ_CONCURRENCY);
      const results = await Promise.all(batch.map((p) => readOne(p)));

      for (const result of results) {
        if (ctx.signal?.aborted) return;
        current++;

        if (result.kind === 'skip') {
          ctx.onProgress?.({
            current,
            total,
            message: `⚠ Skipped ${basename(result.filePath)}: ${result.reason}`,
          });
          continue;
        }
        if (result.kind === 'empty') continue;

        // Defensive: a bug in emailToDocument (or unexpected payload)
        // shouldn't take the whole plugin down — log and continue.
        try {
          yield emailToDocument(result.email, result.filePath, result.mtimeMs);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          ctx.onProgress?.({
            current,
            total,
            message: `⚠ Skipped ${basename(result.filePath)}: ${reason}`,
          });
        }
      }

      if (current % 25 < FILE_READ_CONCURRENCY || i === 0) {
        ctx.onProgress?.({ current, total, message: `${current}/${total} messages` });
      }
    }
  },
};

const FILE_READ_CONCURRENCY = 4;

type ReadResult =
  | { kind: 'ok'; email: ParsedEmail; filePath: string; mtimeMs: number }
  | { kind: 'skip'; filePath: string; reason: string }
  | { kind: 'empty'; filePath: string };

async function readOne(filePath: string): Promise<ReadResult> {
  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_BYTES) {
      return {
        kind: 'skip',
        filePath,
        reason: `${(stats.size / 1024 / 1024).toFixed(1)}MB > ${MAX_FILE_BYTES / 1024 / 1024}MB`,
      };
    }

    const raw = await readFile(filePath, 'utf-8');
    const email = await parseWithTimeout(raw, PER_MESSAGE_TIMEOUT_MS);
    if (!email) return { kind: 'empty', filePath };

    return { kind: 'ok', email, filePath, mtimeMs: stats.mtimeMs };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'skip', filePath, reason };
  }
}

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
 * Pick the most-recently-modified `limit` files newer than `minMtimeMs`.
 * Avoids stat'ing all 100k messages by using a top-k heap pattern.
 *
 * Pass minMtimeMs=0 to disable the date floor.
 */
async function pickRecentSince(
  files: string[],
  limit: number,
  minMtimeMs: number,
): Promise<string[]> {
  interface FileWithMtime {
    path: string;
    mtimeMs: number;
  }

  const top: FileWithMtime[] = [];
  let topMin = Number.NEGATIVE_INFINITY;

  for (const file of files) {
    let mtime = 0;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < minMtimeMs) continue;

    if (top.length < limit) {
      top.push({ path: file, mtimeMs: mtime });
      if (top.length === limit) {
        topMin = Math.min(...top.map((f) => f.mtimeMs));
      }
    } else if (mtime > topMin) {
      // Replace the oldest entry; recompute min.
      let minIdx = 0;
      for (let i = 1; i < top.length; i++) {
        const t = top[i];
        const m = top[minIdx];
        if (t && m && t.mtimeMs < m.mtimeMs) minIdx = i;
      }
      top[minIdx] = { path: file, mtimeMs: mtime };
      topMin = Math.min(...top.map((f) => f.mtimeMs));
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
