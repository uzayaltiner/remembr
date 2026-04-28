/**
 * Safari history reader.
 *
 * Schema (Safari ≥ 14):
 *   history_items   (id, url, visit_count, ...)
 *   history_visits  (id, history_item, visit_time, title, ...)
 *
 * Safari times are seconds since 2001-01-01 UTC (Mac absolute time).
 * Note: visit_time is REAL (float) — keep precision in JS Number range.
 */

import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BrowserHistoryEntry, ReadOptions } from './types.js';

// Seconds between Unix epoch (1970-01-01) and Mac epoch (2001-01-01).
const MAC_EPOCH_OFFSET_S = 978_307_200;

interface SafariRow {
  url: string;
  title: string | null;
  visit_count: number;
  last_visit_time: number;
}

export function readSafariHistory(
  historyPath: string,
  options: ReadOptions,
): BrowserHistoryEntry[] {
  const tempPath = join(tmpdir(), `remembr-safari-${Date.now()}.db`);

  try {
    copyFileSync(historyPath, tempPath);
  } catch (err) {
    if (err instanceof Error && /EPERM|EACCES/.test(err.message)) {
      throw new Error(
        'Safari history is protected by macOS Full Disk Access.\n' +
          '  Grant access to your terminal app:\n' +
          '    System Settings → Privacy & Security → Full Disk Access → add Terminal/iTerm/etc.\n' +
          '  Then restart the terminal and try again.',
      );
    }
    throw err;
  }

  // Safari WAL files travel alongside the main DB; copy them too if present
  // so the read sees a consistent snapshot.
  for (const ext of ['-wal', '-shm']) {
    try {
      copyFileSync(`${historyPath}${ext}`, `${tempPath}${ext}`);
    } catch {
      // not all DBs have WAL files at copy time
    }
  }

  try {
    const db = new Database(tempPath, { readonly: true });

    const cutoffMacSeconds = unixMsToMacSeconds(
      Date.now() - options.maxAgeDays * 24 * 60 * 60 * 1000,
    );

    const rows = db
      .prepare(
        `
        SELECT
          hi.url            AS url,
          hv.title          AS title,
          hi.visit_count    AS visit_count,
          MAX(hv.visit_time) AS last_visit_time
        FROM history_items hi
        JOIN history_visits hv ON hv.history_item = hi.id
        WHERE hv.visit_time > ?
          AND hi.visit_count >= ?
        GROUP BY hi.id
        ORDER BY last_visit_time DESC
      `,
      )
      .all(cutoffMacSeconds, options.minVisitCount) as SafariRow[];

    db.close();

    return rows
      .filter((r) => r.title && r.title.trim().length > 0)
      .map((r) => ({
        browser: 'safari',
        url: r.url,
        title: r.title ?? '',
        visitCount: r.visit_count,
        lastVisitTime: macSecondsToUnixMs(r.last_visit_time),
      }));
  } finally {
    rmSync(tempPath, { force: true });
    for (const ext of ['-wal', '-shm']) {
      rmSync(`${tempPath}${ext}`, { force: true });
    }
  }
}

export function macSecondsToUnixMs(macSeconds: number): number {
  return Math.round((macSeconds + MAC_EPOCH_OFFSET_S) * 1000);
}

export function unixMsToMacSeconds(unixMs: number): number {
  return unixMs / 1000 - MAC_EPOCH_OFFSET_S;
}
