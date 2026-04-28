/**
 * Apple Notes source plugin (macOS, live).
 *
 * Reads ~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite
 * — the live database backing Notes.app. Apple has not published this
 * schema; what we do here is the result of community reverse engineering
 * (the most cited write-up: https://ciofecaforensics.com/2020/04/15/apple-notes-revisited-1/).
 *
 * Caveats — read carefully before relying on this in production:
 *
 *   1. Full Disk Access is required. The database lives under TCC and we
 *      surface a clear error if we can't read it.
 *   2. The schema CHANGES between major macOS versions. We extract the
 *      minimum set of fields we need (title, snippet, modified date,
 *      folder, deletion flag) so we are robust to additional columns,
 *      but Apple could rename anything tomorrow.
 *   3. The note body is stored as a gzipped protobuf (`ZICNOTEDATA.ZDATA`).
 *      Decoding that requires a protobuf schema we don't yet ship —
 *      attempting it here would add ~50KB of generated code and a
 *      dependency we don't need today. Instead we use ZICCLOUDSYNCINGOBJECT.
 *      ZSNIPPET, which is the title + first ~200 characters that Notes
 *      itself shows in the sidebar. That's surprisingly good for retrieval.
 *      Full-body decoding lives on the v0.3 roadmap.
 *
 * For users who want full-body indexing today, recommend exporting notes
 * via Notes.app → File → Export as PDF → put them in `~/.../Notes-export`
 * and use the `pdf` plugin.
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Document, IngestContext, Plugin } from '../types.ts';

const NAME = 'apple-notes';

const NOTESTORE_PATH = join(
  homedir(),
  'Library',
  'Group Containers',
  'group.com.apple.notes',
  'NoteStore.sqlite',
);

interface NoteRow {
  identifier: string;
  title: string | null;
  snippet: string | null;
  folder: string | null;
  modified: number | null; // Apple "Mac absolute time": seconds since 2001-01-01 UTC
  isDeleted: number;
}

const MAC_EPOCH_OFFSET_S = 978_307_200;

export const appleNotesPlugin: Plugin = {
  name: NAME,
  version: '0.1.0',
  description: 'Indexes Apple Notes (titles + sidebar snippets, macOS only).',

  async isAvailable(): Promise<boolean> {
    return existsSync(NOTESTORE_PATH);
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    if (!existsSync(NOTESTORE_PATH)) {
      throw new Error(
        `Apple Notes database not found. Are you on macOS?\n  Looked at: ${NOTESTORE_PATH}`,
      );
    }

    // Notes.app holds an exclusive lock on the live DB. Copy first.
    const tempPath = join(tmpdir(), `remembr-notes-${Date.now()}.sqlite`);
    try {
      copyFileSync(NOTESTORE_PATH, tempPath);
      // WAL companions:
      for (const ext of ['-wal', '-shm']) {
        try {
          copyFileSync(`${NOTESTORE_PATH}${ext}`, `${tempPath}${ext}`);
        } catch {
          // not always present
        }
      }
    } catch (err) {
      if (err instanceof Error && /EPERM|EACCES/.test(err.message)) {
        throw new Error(
          'Apple Notes database is protected by macOS Full Disk Access.\n  Grant your terminal access:\n    System Settings → Privacy & Security → Full Disk Access → add Terminal/iTerm/Warp/Ghostty\n  Then restart the terminal and re-run.',
        );
      }
      throw err;
    }

    const db = new Database(tempPath, { readonly: true });
    try {
      const rows = db
        .query<NoteRow, []>(`
          SELECT
            obj.ZIDENTIFIER                                AS identifier,
            obj.ZTITLE1                                    AS title,
            obj.ZSNIPPET                                   AS snippet,
            folder.ZTITLE2                                 AS folder,
            obj.ZMODIFICATIONDATE1                         AS modified,
            COALESCE(obj.ZMARKEDFORDELETION, 0)            AS isDeleted
          FROM ZICCLOUDSYNCINGOBJECT obj
          LEFT JOIN ZICCLOUDSYNCINGOBJECT folder
            ON folder.Z_PK = obj.ZFOLDER
          WHERE obj.ZTITLE1 IS NOT NULL
            AND COALESCE(obj.ZMARKEDFORDELETION, 0) = 0
          ORDER BY obj.ZMODIFICATIONDATE1 DESC
        `)
        .all();

      const total = rows.length;
      let current = 0;
      ctx.onProgress?.({ current, total, message: `Found ${total} notes` });

      for (const row of rows) {
        if (ctx.signal?.aborted) return;
        current++;

        const title = (row.title ?? '').trim();
        const snippet = (row.snippet ?? '').trim();
        if (!title && !snippet) continue;

        const modifiedMs = row.modified !== null ? macSecondsToMs(row.modified) : Date.now();

        yield {
          id: row.identifier,
          title: title || snippet.slice(0, 60),
          // The snippet usually starts with the title; we still concatenate
          // because the model's mean-pooling benefits from the title appearing
          // explicitly.
          content: title ? `${title}\n${snippet}` : snippet,
          timestamp: modifiedMs,
          fingerprint: `${row.identifier}-${row.modified ?? 0}`,
          metadata: {
            folder: row.folder,
            modifiedAt: modifiedMs,
          },
        };

        if (current % 50 === 0) {
          ctx.onProgress?.({ current, total, message: `${current}/${total} notes` });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no such (table|column)/i.test(message)) {
        throw new Error(
          `Apple Notes schema mismatch — Apple changed the database between macOS versions.\n  Underlying error: ${message}\n  Please file an issue: https://github.com/uzayaltiner/remembr/issues`,
        );
      }
      throw err;
    } finally {
      db.close();
      rmSync(tempPath, { force: true });
      for (const ext of ['-wal', '-shm']) {
        rmSync(`${tempPath}${ext}`, { force: true });
      }
    }
  },
};

function macSecondsToMs(macSeconds: number): number {
  return Math.round((macSeconds + MAC_EPOCH_OFFSET_S) * 1000);
}
