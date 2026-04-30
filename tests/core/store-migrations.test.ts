/**
 * Schema migration round-trips.
 *
 * These tests build older-shape databases by hand using better-sqlite3
 * directly — Store always migrates forward so we can't rely on it to
 * produce a v1/v2 starting point. The check is that opening such a file
 * with the current Store leaves it on the latest schema with all data
 * preserved.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/core/store.js';

const DIMS = 4;

function toFloat32Buffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

interface SeedRow {
  source: string;
  documentId: string;
  title: string;
  content: string;
  vector: number[];
}

function defaultSeed(): SeedRow[] {
  return [
    {
      source: 'fs',
      documentId: 'a.md',
      title: 'Alpha',
      content: 'first document',
      vector: [1, 0, 0, 0],
    },
    {
      source: 'fs',
      documentId: 'b.md',
      title: 'Beta',
      content: 'second document',
      vector: [0, 1, 0, 0],
    },
  ];
}

/** Build a v1 database (chunks + chunk_embeddings, no fingerprint, no FTS). */
function buildV1(path: string, seed: SeedRow[] = defaultSeed()): void {
  const db = new Database(path);
  db.loadExtension(sqliteVec.getLoadablePath());
  db.exec(`
    CREATE TABLE chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT NOT NULL,
      document_id  TEXT NOT NULL,
      chunk_index  INTEGER NOT NULL,
      title        TEXT NOT NULL,
      content      TEXT NOT NULL,
      url          TEXT,
      timestamp    INTEGER NOT NULL,
      metadata     TEXT NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_chunks_source ON chunks(source);
    CREATE INDEX idx_chunks_document ON chunks(source, document_id);
    CREATE INDEX idx_chunks_timestamp ON chunks(timestamp DESC);
    CREATE VIRTUAL TABLE chunk_embeddings USING vec0(embedding float[${DIMS}]);
    CREATE TRIGGER chunks_after_delete AFTER DELETE ON chunks
    BEGIN
      DELETE FROM chunk_embeddings WHERE rowid = OLD.id;
    END;
    PRAGMA user_version = 1;
  `);

  const insertChunk = db.prepare(
    'INSERT INTO chunks (source, document_id, chunk_index, title, content, url, timestamp, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertEmbed = db.prepare(
    'INSERT INTO chunk_embeddings (rowid, embedding) VALUES (?, ?)',
  );

  for (const row of seed) {
    const result = insertChunk.run(
      row.source,
      row.documentId,
      0,
      row.title,
      row.content,
      null,
      Date.now(),
      '{}',
      Date.now(),
    );
    insertEmbed.run(BigInt(Number(result.lastInsertRowid)), toFloat32Buffer(row.vector));
  }
  db.close();
}

/** Build a v2 database (v1 + fingerprint column, no FTS). */
function buildV2(path: string, seed: SeedRow[] = defaultSeed()): void {
  buildV1(path, seed);
  const db = new Database(path);
  db.loadExtension(sqliteVec.getLoadablePath());
  db.exec(`
    ALTER TABLE chunks ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
    PRAGMA user_version = 2;
  `);
  db.close();
}

describe('Store schema migrations', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'remembr-mig-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates v1 → v3 and preserves rows', () => {
    buildV1(dbPath);
    const store = new Store({ path: dbPath, dimensions: DIMS });
    try {
      expect(store.count()).toBe(2);
      const results = store.search([1, 0, 0, 0], { limit: 1 });
      expect(results[0]?.title).toBe('Alpha');
      // FTS index was backfilled, so hybrid search should find by content too.
      const hybrid = store.searchHybrid([0, 0, 1, 0], 'second', { limit: 5 });
      expect(hybrid.find((r) => r.documentId === 'b.md')).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('migrates v2 → v3 and preserves rows', () => {
    buildV2(dbPath);
    const store = new Store({ path: dbPath, dimensions: DIMS });
    try {
      expect(store.count()).toBe(2);
      const hybrid = store.searchHybrid([1, 0, 0, 0], 'first', { limit: 5 });
      expect(hybrid.find((r) => r.documentId === 'a.md')).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('is idempotent: re-opening a v3 DB does not re-run migrations', () => {
    buildV2(dbPath);
    const s1 = new Store({ path: dbPath, dimensions: DIMS });
    s1.close();
    // A second open on the now-v3 file should not throw (it would if we
    // tried to re-add the fingerprint column or re-create chunk_fts).
    const s2 = new Store({ path: dbPath, dimensions: DIMS });
    s2.close();
  });

  it('writes a pre-migration snapshot at <db>.pre-v<n>', () => {
    buildV2(dbPath);
    const snapshotPath = `${dbPath}.pre-v2`;
    // Sanity: snapshot should not exist yet.
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.existsSync(snapshotPath)).toBe(false);
    const store = new Store({ path: dbPath, dimensions: DIMS });
    store.close();
    expect(fs.existsSync(snapshotPath)).toBe(true);
  });

  it('refuses a DB with a newer schema than the binary supports', () => {
    buildV2(dbPath);
    const db = new Database(dbPath);
    db.exec('PRAGMA user_version = 999');
    db.close();
    expect(() => new Store({ path: dbPath, dimensions: DIMS })).toThrow(
      /newer than supported/i,
    );
  });
});
