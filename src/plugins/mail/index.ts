/**
 * Apple Mail / generic mbox source plugin.
 *
 * Indexes .mbox files. Apple Mail's local store under ~/Library/Mail/<version>/
 * is the source of truth on macOS, but the path is gated by Full Disk Access
 * AND its layout shifts between major versions.
 *
 * For v0.1 we read mbox files the user explicitly points at — drag a folder
 * out of Mail.app via "Mailbox -> Export..." or use any other client
 * (Thunderbird, Gmail Takeout) that produces mbox.
 *
 * Plugin config (config.plugins.mail):
 *   { "enabled": true, "paths": ["~/Mail Exports"] }
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { glob } from 'glob';
import type { Document, IngestContext, Plugin } from '../types.ts';
import { type ParsedEmail, parseMbox } from './parser.ts';

const NAME = 'mail';

interface MailPluginConfig {
  enabled: boolean;
  paths?: string[];
}

interface MailIngestOverrides {
  paths?: string[];
}

export const mailPlugin: Plugin = {
  name: NAME,
  version: '0.1.0',
  description: 'Indexes .mbox files (Apple Mail exports, Thunderbird, Gmail Takeout).',

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    const config = ctx.config as MailPluginConfig;
    const overrides = (ctx.config._overrides as MailIngestOverrides | undefined) ?? {};

    const rawPaths = overrides.paths ?? config.paths ?? [];
    const paths = rawPaths.map(expandPath);

    if (paths.length === 0) {
      throw new Error(
        "No paths configured for the 'mail' plugin.\n  Add one: remembr paths add mail ~/MailExports\n  Tip: in Apple Mail, select a mailbox → Mailbox → Export Mailbox… (creates a .mbox folder).",
      );
    }

    const files: string[] = [];
    for (const dir of paths) {
      // Apple Mail exports come as `Inbox.mbox/mbox` — match both nested and flat.
      const matches = await glob(['**/*.mbox', '**/*.mbox/mbox'], {
        cwd: dir,
        absolute: true,
        nodir: true,
      });
      files.push(...matches);
    }

    const total = files.length;
    let current = 0;
    ctx.onProgress?.({ current, total, message: `Found ${total} mbox files` });

    for (const filePath of files) {
      if (ctx.signal?.aborted) return;
      current++;

      try {
        const raw = await readFile(filePath, 'utf-8');
        const stats = await stat(filePath);
        const mbox = basename(filePath).replace(/\.mbox$/, '');
        const emails = parseMbox(raw);

        if (emails.length === 0) {
          ctx.onProgress?.({ current, total, message: `⚠ ${mbox}: no messages` });
          continue;
        }

        for (const email of emails) {
          yield emailToDocument(email, mbox, filePath, stats.mtimeMs);
        }

        ctx.onProgress?.({
          current,
          total,
          message: `Indexed ${mbox} (${emails.length} messages)`,
        });
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

function emailToDocument(
  e: ParsedEmail,
  mbox: string,
  sourcePath: string,
  mtimeMs: number,
): Document {
  const subject = e.subject || '(no subject)';
  const fromLine = e.from ? `From: ${e.from}` : '';
  const toLine = e.to.length > 0 ? `To: ${e.to.join(', ')}` : '';
  const dateLine = e.date ? `Date: ${new Date(e.date).toISOString()}` : '';

  const headerBlock = [fromLine, toLine, dateLine].filter(Boolean).join('\n');
  const content = `${subject}\n${headerBlock}\n\n${e.body}`;

  return {
    id: e.messageId || `${mbox}-${e.date ?? mtimeMs}-${subject}`,
    title: subject,
    content,
    timestamp: e.date ?? mtimeMs,
    fingerprint: `${e.messageId ?? ''}-${e.date ?? 0}`,
    metadata: {
      mbox,
      from: e.from,
      to: e.to,
      cc: e.cc,
      messageId: e.messageId,
      sourcePath,
    },
  };
}

function expandPath(p: string): string {
  let out = p;
  if (out.startsWith('~')) out = join(homedir(), out.slice(1));
  return isAbsolute(out) ? out : resolve(out);
}
