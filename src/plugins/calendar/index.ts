/**
 * Apple Calendar source plugin (macOS, live).
 *
 * Reads the macOS Calendar database directly. No manual exports.
 *
 * Apple has moved this database between several locations across macOS
 * versions, and the schema has shifted with it. Strategy:
 *   1. Probe a list of known candidate paths and pick the first that exists.
 *   2. Copy it to a temp file (the live store is locked / TCC-gated).
 *   3. Introspect sqlite_master to figure out which schema variant we have.
 *   4. Build the query for that variant.
 *   5. If nothing matches, surface a clear schema-mismatch error.
 *
 * Requires Full Disk Access for the terminal, just like Apple Notes.
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Document, IngestContext, Plugin } from '../types.ts';

const NAME = 'calendar';

const CANDIDATE_PATHS = [
  // macOS 14+ (Sonoma, Sequoia): single shared sqlite under group container.
  join(homedir(), 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb'),
  // Older path used by Calendar.app's local cache.
  join(homedir(), 'Library', 'Calendars', 'Calendar Cache'),
];

// Mac absolute time → unix epoch (seconds offset between 2001-01-01 and 1970-01-01).
const MAC_EPOCH_OFFSET_S = 978_307_200;

export const calendarPlugin: Plugin = {
  name: NAME,
  version: '0.2.0',
  description: 'Indexes Apple Calendar events directly from the live database (macOS).',

  async isAvailable(): Promise<boolean> {
    return CANDIDATE_PATHS.some(existsSync);
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    const dbPath = CANDIDATE_PATHS.find(existsSync);
    if (!dbPath) {
      throw new Error(
        `Apple Calendar database not found.\n  Looked in:\n    ${CANDIDATE_PATHS.join('\n    ')}\n  Are you on macOS with Calendar.app set up?`,
      );
    }

    // Calendar.app holds a write lock on the live DB. Copy first.
    const tempPath = join(tmpdir(), `remembr-calendar-${Date.now()}.sqlite`);
    try {
      copyFileSync(dbPath, tempPath);
      for (const ext of ['-wal', '-shm']) {
        try {
          copyFileSync(`${dbPath}${ext}`, `${tempPath}${ext}`);
        } catch {
          // wal/shm aren't always present
        }
      }
    } catch (err) {
      if (err instanceof Error && /EPERM|EACCES/.test(err.message)) {
        throw new Error(
          'Calendar database is protected by macOS Full Disk Access.\n  Grant your terminal access:\n    System Settings → Privacy & Security → Full Disk Access → add Terminal/iTerm/Warp/Ghostty\n  Then restart the terminal and re-run.',
        );
      }
      throw err;
    }

    const db = new Database(tempPath, { readonly: true });
    try {
      const variant = detectSchemaVariant(db);
      ctx.onProgress?.({ current: 0, total: 0, message: `Schema: ${variant}` });

      let events: CalendarRow[];
      try {
        events = readEvents(db, variant);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Calendar schema mismatch (variant=${variant}). Apple may have changed it again.\n  Underlying error: ${message}\n  Please file an issue: https://github.com/uzayaltiner/remembr/issues`,
        );
      }

      const total = events.length;
      let current = 0;
      ctx.onProgress?.({ current, total, message: `Found ${total} events` });

      for (const row of events) {
        if (ctx.signal?.aborted) return;
        current++;
        yield rowToDocument(row);
        if (current % 100 === 0) {
          ctx.onProgress?.({ current, total, message: `${current}/${total} events` });
        }
      }
    } finally {
      db.close();
      rmSync(tempPath, { force: true });
      for (const ext of ['-wal', '-shm']) {
        rmSync(`${tempPath}${ext}`, { force: true });
      }
    }
  },
};

// ──────────────────────────────────────────────────────────
// Schema variants
//
// Variant A — modern Calendar.sqlitedb (group container):
//     CalendarItem(ROWID, external_id, summary, description, start_date,
//                  end_date, all_day, has_recurrences, calendar_id)
//     Calendar(ROWID, title)
//
// Variant B — older Calendar Cache:
//     ZNODE / ZEVENTITEM tables (Z-prefix schema)

type SchemaVariant = 'modern' | 'core-data' | 'unknown';

interface CalendarRow {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  startSeconds: number | null; // Mac absolute time
  endSeconds: number | null;
  allDay: boolean;
  calendarTitle: string | null;
}

function detectSchemaVariant(db: Database): SchemaVariant {
  const rows = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
    .all();
  const names = new Set(rows.map((r) => r.name));

  if (names.has('CalendarItem')) return 'modern';
  if (names.has('ZEVENTITEM') || names.has('ZNODE')) return 'core-data';
  return 'unknown';
}

function readEvents(db: Database, variant: SchemaVariant): CalendarRow[] {
  if (variant === 'modern') return readModern(db);
  if (variant === 'core-data') return readCoreData(db);
  throw new Error('Unknown schema — no recognised tables found.');
}

interface ModernRow {
  external_id: string | null;
  summary: string | null;
  description: string | null;
  start_date: number | null;
  end_date: number | null;
  all_day: number | null;
  calendar_title: string | null;
  location: string | null;
}

function readModern(db: Database): CalendarRow[] {
  // Column names mirror the schema documented at https://ciofecaforensics.com.
  // Some installs lack the optional `Location` table — we LEFT JOIN so missing
  // locations come back as null rather than throwing.
  const rows = db
    .query<ModernRow, []>(`
      SELECT
        ci.external_id              AS external_id,
        ci.summary                  AS summary,
        ci.description              AS description,
        ci.start_date               AS start_date,
        ci.end_date                 AS end_date,
        ci.all_day                  AS all_day,
        c.title                     AS calendar_title,
        loc.title                   AS location
      FROM CalendarItem ci
      LEFT JOIN Calendar c   ON c.ROWID = ci.calendar_id
      LEFT JOIN Location  loc ON loc.ROWID = ci.location_id
      WHERE COALESCE(ci.is_pseudo, 0) = 0
        AND COALESCE(ci.deleted, 0) = 0
      ORDER BY ci.start_date DESC
    `)
    .all();

  return rows.map((r, i) => ({
    uid: r.external_id ?? `modern-${i}`,
    summary: (r.summary ?? '').trim(),
    description: r.description?.trim() || null,
    location: r.location?.trim() || null,
    startSeconds: r.start_date,
    endSeconds: r.end_date,
    allDay: !!r.all_day,
    calendarTitle: r.calendar_title?.trim() || null,
  }));
}

interface CoreDataRow {
  ZEXTERNAL_ID: string | null;
  ZSUMMARY: string | null;
  ZDESCRIPTION: string | null;
  ZSTARTDATE: number | null;
  ZENDDATE: number | null;
  ZISALLDAY: number | null;
  ZCALENDAR_TITLE: string | null;
  ZLOCATION: string | null;
}

function readCoreData(db: Database): CalendarRow[] {
  // Z-prefix Core Data schema. We don't always know what the calendar/location
  // joins look like across versions, so query a flat projection and degrade
  // gracefully if some columns are missing.
  const rows = db
    .query<CoreDataRow, []>(`
      SELECT
        ZEXTERNAL_ID,
        ZSUMMARY,
        ZDESCRIPTION,
        ZSTARTDATE,
        ZENDDATE,
        ZISALLDAY,
        NULL AS ZCALENDAR_TITLE,
        NULL AS ZLOCATION
      FROM ZEVENTITEM
      ORDER BY ZSTARTDATE DESC
    `)
    .all();

  return rows.map((r, i) => ({
    uid: r.ZEXTERNAL_ID ?? `core-data-${i}`,
    summary: (r.ZSUMMARY ?? '').trim(),
    description: r.ZDESCRIPTION?.trim() || null,
    location: r.ZLOCATION?.trim() || null,
    startSeconds: r.ZSTARTDATE,
    endSeconds: r.ZENDDATE,
    allDay: !!r.ZISALLDAY,
    calendarTitle: r.ZCALENDAR_TITLE?.trim() || null,
  }));
}

// ──────────────────────────────────────────────────────────

function rowToDocument(r: CalendarRow): Document {
  const startMs = r.startSeconds !== null ? macSecondsToMs(r.startSeconds) : null;
  const endMs = r.endSeconds !== null ? macSecondsToMs(r.endSeconds) : null;
  const dateLabel = startMs ? formatDate(startMs, r.allDay) : 'unscheduled';
  const title = r.summary || '(untitled event)';

  const lines = [`${dateLabel} — ${title}`];
  if (r.calendarTitle) lines.push(`Calendar: ${r.calendarTitle}`);
  if (r.location) lines.push(`📍 ${r.location}`);
  if (r.description) lines.push('', r.description);

  return {
    id: r.uid,
    title,
    content: lines.join('\n'),
    timestamp: startMs ?? Date.now(),
    fingerprint: `${r.uid}-${r.startSeconds ?? 0}-${r.endSeconds ?? 0}`,
    metadata: {
      calendar: r.calendarTitle,
      start: startMs,
      end: endMs,
      allDay: r.allDay,
      location: r.location,
    },
  };
}

function macSecondsToMs(macSeconds: number): number {
  return Math.round((macSeconds + MAC_EPOCH_OFFSET_S) * 1000);
}

function formatDate(unixMs: number, allDay: boolean): string {
  const d = new Date(unixMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (allDay) return `${yyyy}-${mm}-${dd}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mn = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mn} UTC`;
}
