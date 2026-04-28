import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromiumMicrosToUnixMs,
  readChromiumHistory,
  unixMsToChromiumMicros,
} from '../../src/plugins/browser/chromium.js';
import {
  macSecondsToUnixMs,
  readSafariHistory,
  unixMsToMacSeconds,
} from '../../src/plugins/browser/safari.js';

describe('Chromium epoch helpers', () => {
  it('round-trips a unix ms timestamp', () => {
    const original = 1_700_000_000_000; // sometime in late 2023
    const round = chromiumMicrosToUnixMs(unixMsToChromiumMicros(original));
    expect(round).toBe(original);
  });

  it('converts a known fixed point', () => {
    // 1970-01-01 00:00:00 UTC in Chromium time = 11644473600000000 microseconds
    expect(chromiumMicrosToUnixMs(11_644_473_600_000_000)).toBe(0);
  });
});

describe('Safari (Mac) epoch helpers', () => {
  it('round-trips a unix ms timestamp', () => {
    const original = 1_700_000_000_000;
    const round = macSecondsToUnixMs(unixMsToMacSeconds(original));
    expect(round).toBe(original);
  });

  it('converts a known fixed point', () => {
    // 2001-01-01 00:00:00 UTC in Mac time = 0 seconds
    // Same moment in Unix ms = 978_307_200_000
    expect(macSecondsToUnixMs(0)).toBe(978_307_200_000);
  });
});

describe('readChromiumHistory', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'localbrain-chromium-fixture-'));
    dbPath = join(tmpDir, 'History');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE urls (
        id INTEGER PRIMARY KEY,
        url LONGVARCHAR,
        title LONGVARCHAR,
        visit_count INTEGER DEFAULT 0,
        typed_count INTEGER DEFAULT 0,
        last_visit_time INTEGER NOT NULL,
        hidden INTEGER DEFAULT 0
      );
    `);

    const insert = db.prepare(
      'INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, ?, ?)',
    );
    const now = Date.now();

    insert.run('https://example.com/recent', 'Recent', 5, unixMsToChromiumMicros(now - 1000));
    insert.run(
      'https://example.com/old',
      'Old',
      3,
      unixMsToChromiumMicros(now - 365 * 24 * 60 * 60 * 1000),
    );
    insert.run('https://example.com/lone', 'Lone', 0, unixMsToChromiumMicros(now - 1000));
    insert.run('https://example.com/empty', '', 5, unixMsToChromiumMicros(now - 1000));

    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads recent entries, filters by age and visit count', () => {
    const entries = readChromiumHistory(dbPath, 'chrome', { maxAgeDays: 30, minVisitCount: 1 });

    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://example.com/recent');
    expect(urls).not.toContain('https://example.com/old');
    expect(urls).not.toContain('https://example.com/lone');
    expect(urls).not.toContain('https://example.com/empty');
  });

  it('attaches the browser name to each entry', () => {
    const entries = readChromiumHistory(dbPath, 'arc', { maxAgeDays: 30, minVisitCount: 1 });
    expect(entries.every((e) => e.browser === 'arc')).toBe(true);
  });

  it('returns visit counts and timestamps', () => {
    const entries = readChromiumHistory(dbPath, 'chrome', { maxAgeDays: 30, minVisitCount: 1 });
    const recent = entries.find((e) => e.url === 'https://example.com/recent');
    expect(recent?.visitCount).toBe(5);
    expect(recent?.title).toBe('Recent');
    expect(typeof recent?.lastVisitTime).toBe('number');
  });
});

describe('readSafariHistory', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'localbrain-safari-fixture-'));
    dbPath = join(tmpDir, 'History.db');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE history_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        domain_expansion TEXT,
        visit_count INTEGER NOT NULL,
        daily_visit_counts BLOB,
        weekly_visit_counts BLOB,
        autocomplete_triggers BLOB,
        should_recompute_derived_visit_counts INTEGER,
        visit_count_score INTEGER
      );
      CREATE TABLE history_visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        history_item INTEGER NOT NULL,
        visit_time REAL NOT NULL,
        title TEXT,
        load_successful BOOLEAN
      );
    `);

    const now = Date.now();
    const insertItem = db.prepare(
      'INSERT INTO history_items (url, visit_count) VALUES (?, ?)',
    );
    const insertVisit = db.prepare(
      'INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)',
    );

    const recent = insertItem.run('https://safari.test/recent', 4);
    insertVisit.run(recent.lastInsertRowid, unixMsToMacSeconds(now - 1000), 'Safari Recent');

    const old = insertItem.run('https://safari.test/old', 2);
    insertVisit.run(
      old.lastInsertRowid,
      unixMsToMacSeconds(now - 365 * 24 * 60 * 60 * 1000),
      'Safari Old',
    );

    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads recent entries with title', () => {
    const entries = readSafariHistory(dbPath, { maxAgeDays: 30, minVisitCount: 1 });
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://safari.test/recent');
    expect(urls).not.toContain('https://safari.test/old');

    const recent = entries.find((e) => e.url === 'https://safari.test/recent');
    expect(recent?.title).toBe('Safari Recent');
    expect(recent?.browser).toBe('safari');
    expect(recent?.visitCount).toBe(4);
  });
});
