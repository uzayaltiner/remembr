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

      try {
        const raw = await readFile(filePath, 'utf-8');
        const stats = await stat(filePath);
        const email = parseEmlx(raw);
        if (!email) continue;

        yield emailToDocument(email, filePath, stats.mtimeMs);

        if (current % 100 === 0) {
          ctx.onProgress?.({ current, total, message: `${current}/${total} messages` });
        }
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
  const content = `${subject}\n${headerBlock}\n\n${e.body}`;

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
    },
  };
}
