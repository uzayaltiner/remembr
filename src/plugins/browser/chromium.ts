/**
 * Chromium-family history reader.
 *
 * Used for Chrome, Arc, Brave, Edge, Vivaldi — they all share the same
 * SQLite schema (`History` file with `urls` and `visits` tables).
 *
 * Time format: microseconds since 1601-01-01 UTC.
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserHistoryEntry, ReadOptions } from './types.ts';

// Difference between Chromium epoch (1601-01-01) and Unix epoch (1970-01-01),
// expressed in microseconds. Constant — pre-computed.
const CHROMIUM_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000;

interface UrlRow {
  url: string;
  title: string;
  visit_count: number;
  last_visit_time: number;
}

export function readChromiumHistory(
  historyPath: string,
  browserName: string,
  options: ReadOptions,
): BrowserHistoryEntry[] {
  // Browsers hold an exclusive lock on the live DB while running.
  // Copy to a temp file and read that instead. Safe and decouples us
  // from whatever the browser is doing.
  const tempPath = join(tmpdir(), `remembr-${browserName}-${Date.now()}.db`);
  copyFileSync(historyPath, tempPath);

  try {
    const db = new Database(tempPath, { readonly: true });

    const cutoffChromium = unixMsToChromiumMicros(
      Date.now() - options.maxAgeDays * 24 * 60 * 60 * 1000,
    );

    const rows = db
      .prepare(
        `
        SELECT url, title, visit_count, last_visit_time
        FROM urls
        WHERE last_visit_time > ?
          AND visit_count >= ?
          AND title <> ''
        ORDER BY last_visit_time DESC
      `,
      )
      .all(cutoffChromium, options.minVisitCount) as UrlRow[];

    db.close();

    return rows.map((r) => ({
      browser: browserName,
      url: r.url,
      title: r.title,
      visitCount: r.visit_count,
      lastVisitTime: chromiumMicrosToUnixMs(r.last_visit_time),
    }));
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function chromiumMicrosToUnixMs(chromiumMicros: number): number {
  return Math.round((chromiumMicros - CHROMIUM_EPOCH_OFFSET_MICROS) / 1000);
}

export function unixMsToChromiumMicros(unixMs: number): number {
  return unixMs * 1000 + CHROMIUM_EPOCH_OFFSET_MICROS;
}
