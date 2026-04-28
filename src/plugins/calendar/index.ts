/**
 * Calendar source plugin.
 *
 * Reads .ics (iCalendar) files from configured directories and indexes one
 * Document per VEVENT. Works with any calendar that can export ICS:
 *   - Apple Calendar: File → Export → "Export…"
 *   - Google Calendar: Settings → Export
 *   - Fastmail / Proton / Outlook: download .ics
 *
 * We do NOT read Apple Calendar's live SQLite database. That path is
 * gated by macOS TCC (Full Disk Access), changes between OS versions, and
 * isn't cross-platform. ICS gives us a deterministic input.
 *
 * Plugin config (config.plugins.calendar):
 *   { "enabled": true, "paths": ["~/Documents/Calendars"] }
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { glob } from 'glob';
import type { Document, IngestContext, Plugin } from '../types.ts';
import { type CalendarEvent, parseIcs } from './parser.ts';

const NAME = 'calendar';

interface CalendarPluginConfig {
  enabled: boolean;
  paths?: string[];
}

interface CalendarIngestOverrides {
  paths?: string[];
}

export const calendarPlugin: Plugin = {
  name: NAME,
  version: '0.1.0',
  description: 'Indexes .ics calendar exports (Apple Calendar, Google, Outlook, …).',

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    const config = ctx.config as CalendarPluginConfig;
    const overrides = (ctx.config._overrides as CalendarIngestOverrides | undefined) ?? {};

    const rawPaths = overrides.paths ?? config.paths ?? [];
    const paths = rawPaths.map(expandPath);

    if (paths.length === 0) {
      throw new Error(
        "No paths configured for the 'calendar' plugin.\n  Add one: remembr paths add calendar ~/Documents/Calendars\n  Tip: in Apple Calendar, File → Export → save the .ics anywhere on disk.",
      );
    }

    const files: string[] = [];
    for (const dir of paths) {
      const matches = await glob('**/*.ics', { cwd: dir, absolute: true, nodir: true });
      files.push(...matches);
    }

    const total = files.length;
    let current = 0;
    ctx.onProgress?.({ current, total, message: `Found ${total} ICS files` });

    for (const filePath of files) {
      if (ctx.signal?.aborted) return;
      current++;

      try {
        const raw = await readFile(filePath, 'utf-8');
        const stats = await stat(filePath);
        const calendarName = basename(filePath, '.ics');
        const events = parseIcs(raw, calendarName);

        if (events.length === 0) {
          ctx.onProgress?.({
            current,
            total,
            message: `⚠ ${calendarName}: no events`,
          });
          continue;
        }

        for (const event of events) {
          yield eventToDocument(event, filePath, stats.mtimeMs);
        }

        ctx.onProgress?.({
          current,
          total,
          message: `Indexed ${calendarName} (${events.length} events)`,
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

function eventToDocument(e: CalendarEvent, sourcePath: string, mtimeMs: number): Document {
  const dateStr = e.start ? formatDate(e.start, e.allDay) : 'unscheduled';
  const title = e.summary || e.uid;
  const lines = [`${dateStr} — ${title}`];
  if (e.location) lines.push(`📍 ${e.location}`);
  if (e.organizer) lines.push(`Organizer: ${e.organizer}`);
  if (e.attendees.length > 0) lines.push(`Attendees: ${e.attendees.join(', ')}`);
  if (e.description) lines.push('', e.description);

  const content = lines.join('\n');

  // Prefer event start as timestamp so date-based queries make sense.
  const timestamp = e.start ?? mtimeMs;

  return {
    id: e.uid,
    title,
    content,
    timestamp,
    fingerprint: `${e.uid}-${e.start ?? 0}-${e.end ?? 0}`,
    metadata: {
      calendar: e.calendar,
      sourcePath,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      location: e.location,
      organizer: e.organizer,
      attendees: e.attendees,
    },
  };
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

function expandPath(p: string): string {
  let out = p;
  if (out.startsWith('~')) out = join(homedir(), out.slice(1));
  return isAbsolute(out) ? out : resolve(out);
}
