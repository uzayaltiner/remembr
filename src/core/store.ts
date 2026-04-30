/**
 * Local-first persistence layer.
 *
 * better-sqlite3 + sqlite-vec virtual table for kNN search + FTS5 for
 * keyword recall. Single file at ~/.remembr/db.sqlite. No server, no daemon.
 *
 * better-sqlite3 vendors its own SQLite build with extension support, so
 * sqlite-vec loads without any system-sqlite dance.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

type DatabaseType = Database.Database;
type Statement = Database.Statement;

const SCHEMA_VERSION = 3;

export interface ChunkInput {
  source: string; // plugin name: 'markdown', 'browser', ...
  documentId: string; // plugin-side stable id (e.g., file path)
  chunkIndex: number; // 0-based ordinal within the document
  title: string;
  content: string;
  url?: string | null;
  timestamp: number; // unix epoch (ms)
  metadata?: Record<string, unknown>;
  /**
   * Document-level identity hash (e.g. mtime+size for files).
   * Same fingerprint = no need to re-embed. Different = stale, re-index.
   * Empty string = "always re-index this document".
   */
  fingerprint?: string;
}

export interface ChunkRecord extends ChunkInput {
  id: number;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface SearchResult extends ChunkRecord {
  distance: number; // smaller = closer (cosine distance)
}

export interface SearchOptions {
  limit?: number;
  source?: string; // restrict to a single plugin's data
}

export interface StoreOptions {
  path: string;
  /** Embedding dimensions (must match the model). Default 768 (nomic-embed-text). */
  dimensions?: number;
}

interface ChunkRow {
  id: number;
  source: string;
  document_id: string;
  chunk_index: number;
  title: string;
  content: string;
  url: string | null;
  timestamp: number;
  metadata: string;
  created_at: number;
}

interface SearchRow extends ChunkRow {
  distance: number;
}

export class Store {
  private readonly db: DatabaseType;
  private readonly dimensions: number;

  // Prepared statements (cached for performance)
  private readonly insertChunkStmt: Statement;
  private readonly insertEmbeddingStmt: Statement;
  private readonly insertFtsStmt: Statement;
  private readonly deleteBySourceStmt: Statement;
  private readonly deleteDocumentStmt: Statement;
  private readonly countAllStmt: Statement;
  private readonly countBySourceStmt: Statement;
  private readonly fingerprintStmt: Statement;
  private readonly listDocumentIdsStmt: Statement;

  // Transaction-wrapped insert (constructed after db is ready)
  private readonly insertChunkTx: (chunk: ChunkInput, vector: number[]) => number;
  private readonly insertChunkBatchTx: (
    items: ReadonlyArray<{ chunk: ChunkInput; vector: number[] }>,
  ) => number[];

  constructor(options: StoreOptions) {
    this.dimensions = options.dimensions ?? 768;

    this.db = new Database(options.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    // Wait up to 10s for another writer (e.g. the MCP server running in
    // parallel) to release a lock instead of failing immediately with
    // SQLITE_BUSY. Index runs are bursty enough that this almost always
    // succeeds inside the window.
    this.db.exec('PRAGMA busy_timeout = 10000');

    this.db.loadExtension(sqliteVec.getLoadablePath());

    this.applySchema();

    this.insertChunkStmt = this.db.prepare(`
      INSERT INTO chunks (
        source, document_id, chunk_index, title, content, url,
        timestamp, metadata, fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertEmbeddingStmt = this.db.prepare(`
      INSERT INTO chunk_embeddings (rowid, embedding) VALUES (?, ?)
    `);

    this.insertFtsStmt = this.db.prepare(`
      INSERT INTO chunk_fts (rowid, title, content) VALUES (?, ?, ?)
    `);

    this.deleteBySourceStmt = this.db.prepare('DELETE FROM chunks WHERE source = ?');
    this.deleteDocumentStmt = this.db.prepare(
      'DELETE FROM chunks WHERE source = ? AND document_id = ?',
    );
    this.countAllStmt = this.db.prepare('SELECT COUNT(*) AS n FROM chunks');
    this.countBySourceStmt = this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE source = ?');
    this.fingerprintStmt = this.db.prepare(
      'SELECT fingerprint FROM chunks WHERE source = ? AND document_id = ? LIMIT 1',
    );
    this.listDocumentIdsStmt = this.db.prepare(
      'SELECT DISTINCT document_id FROM chunks WHERE source = ?',
    );

    const insertOne = (chunk: ChunkInput, vector: number[]): number => {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Embedding dimension mismatch: got ${vector.length}, expected ${this.dimensions}`,
        );
      }

      const result = this.insertChunkStmt.run(
        chunk.source,
        chunk.documentId,
        chunk.chunkIndex,
        chunk.title,
        chunk.content,
        chunk.url ?? null,
        chunk.timestamp,
        JSON.stringify(chunk.metadata ?? {}),
        chunk.fingerprint ?? '',
        Date.now(),
      );

      const id = Number(result.lastInsertRowid);
      // sqlite-vec's vec0 virtual table requires the rowid bound as a
      // strict integer — JS Number sometimes binds as REAL, which it rejects.
      this.insertEmbeddingStmt.run(BigInt(id), toFloat32Buffer(vector));
      this.insertFtsStmt.run(BigInt(id), chunk.title, chunk.content);
      return id;
    };

    this.insertChunkTx = this.db.transaction(insertOne);

    // Batched variant — single transaction commits N rows at once.
    // Saves the per-row fsync cost; ~15-25% faster on bulk index runs.
    this.insertChunkBatchTx = this.db.transaction(
      (items: ReadonlyArray<{ chunk: ChunkInput; vector: number[] }>): number[] => {
        const ids: number[] = [];
        for (const item of items) {
          ids.push(insertOne(item.chunk, item.vector));
        }
        return ids;
      },
    );
  }

  /** Return the fingerprint stored for a document, or null if not indexed. */
  getDocumentFingerprint(source: string, documentId: string): string | null {
    const row = this.fingerprintStmt.get(source, documentId) as { fingerprint: string } | undefined;
    return row ? row.fingerprint : null;
  }

  /**
   * Delete all chunks for a single document. Cascades to embeddings via trigger.
   * Returns the number of *chunks* removed (cascade rows are excluded).
   */
  deleteDocument(source: string, documentId: string): number {
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE source = ? AND document_id = ?')
      .get(source, documentId) as { n: number };
    this.deleteDocumentStmt.run(source, documentId);
    return countRow.n;
  }

  /** List all distinct document_ids stored for a given source. */
  listDocumentIds(source: string): string[] {
    const rows = this.listDocumentIdsStmt.all(source) as Array<{ document_id: string }>;
    return rows.map((r) => r.document_id);
  }

  /**
   * Insert a chunk and its embedding atomically.
   * Returns the rowid of the new chunk.
   */
  upsertChunk(chunk: ChunkInput, vector: number[]): number {
    return this.insertChunkTx(chunk, vector);
  }

  /**
   * Bulk insert variant — wraps every chunk in a single transaction so the
   * fsync only happens once per batch instead of once per chunk. Use this
   * from the indexer when you already have N (chunk, vector) pairs in hand.
   */
  upsertChunks(items: ReadonlyArray<{ chunk: ChunkInput; vector: number[] }>): number[] {
    if (items.length === 0) return [];
    return this.insertChunkBatchTx(items);
  }

  /** Pure semantic search (kNN via sqlite-vec). */
  search(queryVector: number[], options: SearchOptions = {}): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query dimension mismatch: got ${queryVector.length}, expected ${this.dimensions}`,
      );
    }

    const limit = options.limit ?? 10;
    const buffer = toFloat32Buffer(queryVector);
    const overFetch = options.source ? Math.min(limit * 5, 200) : limit;

    const stmt = this.db.prepare(`
      SELECT
        c.id, c.source, c.document_id, c.chunk_index, c.title, c.content,
        c.url, c.timestamp, c.metadata, c.created_at,
        e.distance
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.rowid
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `);

    const rows = stmt.all(buffer, overFetch) as SearchRow[];

    const filtered = options.source
      ? rows.filter((r) => r.source === options.source).slice(0, limit)
      : rows.slice(0, limit);

    return filtered.map(rowToResult);
  }

  /**
   * Hybrid search: combine semantic kNN and FTS5 keyword scores via
   * Reciprocal Rank Fusion (RRF). RRF is robust because it ignores the
   * absolute score scales of each retriever — only ranks matter.
   *
   *   rrf(d) = sum over retrievers r of 1 / (k + rank_r(d))
   *
   * In practice k=60 is the standard.
   */
  searchHybrid(
    queryVector: number[],
    queryText: string,
    options: SearchOptions = {},
  ): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query dimension mismatch: got ${queryVector.length}, expected ${this.dimensions}`,
      );
    }

    const limit = options.limit ?? 10;
    const overFetch = Math.max(limit * 6, 60);
    const RRF_K = 60;

    // Semantic ranks
    const semantic = this.search(queryVector, { limit: overFetch });
    const semanticRank = new Map<number, number>();
    semantic.forEach((r, i) => semanticRank.set(r.id, i + 1));

    // Keyword ranks via FTS5
    const ftsQuery = toFtsQuery(queryText);
    let keyword: SearchRow[] = [];
    if (ftsQuery.length > 0) {
      try {
        const ftsStmt = this.db.prepare(`
          SELECT
            c.id, c.source, c.document_id, c.chunk_index, c.title, c.content,
            c.url, c.timestamp, c.metadata, c.created_at,
            chunk_fts.rank AS distance
          FROM chunk_fts
          JOIN chunks c ON c.id = chunk_fts.rowid
          WHERE chunk_fts MATCH ?
          ORDER BY chunk_fts.rank
          LIMIT ?
        `);
        keyword = ftsStmt.all(ftsQuery, overFetch) as SearchRow[];
      } catch {
        // FTS5 query parse error (e.g. weird punctuation) — silently degrade
        // to pure semantic results. We could log this but it's noisy.
        keyword = [];
      }
    }
    const keywordRank = new Map<number, number>();
    keyword.forEach((r, i) => keywordRank.set(r.id, i + 1));

    // Build a unified pool indexed by chunk id
    const pool = new Map<number, SearchResult>();
    for (const r of semantic) pool.set(r.id, r);
    for (const r of keyword) {
      if (!pool.has(r.id)) pool.set(r.id, rowToResult(r));
    }

    // RRF score per chunk
    const scored = Array.from(pool.values()).map((r) => {
      const sRank = semanticRank.get(r.id);
      const kRank = keywordRank.get(r.id);
      const rrf = (sRank ? 1 / (RRF_K + sRank) : 0) + (kRank ? 1 / (RRF_K + kRank) : 0);
      // Stash the RRF score in the distance slot (lower distance = better, so
      // negate). Callers that need true cosine distance can run search() directly.
      return { ...r, distance: -rrf };
    });

    scored.sort((a, b) => a.distance - b.distance);

    const filtered = options.source ? scored.filter((r) => r.source === options.source) : scored;
    return filtered.slice(0, limit);
  }

  /**
   * Delete all chunks (and their embeddings via cascade) from a source.
   * Returns the number of *chunks* removed (cascade rows are excluded).
   *
   * `result.changes` from the underlying driver rolls cascade-trigger writes
   * into the total, so we count first and rely on that number.
   */
  deleteBySource(source: string): number {
    const before = this.count(source);
    this.deleteBySourceStmt.run(source);
    return before;
  }

  count(source?: string): number {
    const row = source
      ? (this.countBySourceStmt.get(source) as { n: number })
      : (this.countAllStmt.get() as { n: number });
    return row.n;
  }

  close(): void {
    this.db.close();
  }

  private applySchema(): void {
    const versionRow = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    } | null;
    const currentVersion = versionRow?.user_version ?? 0;

    if (currentVersion === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source       TEXT NOT NULL,
          document_id  TEXT NOT NULL,
          chunk_index  INTEGER NOT NULL,
          title        TEXT NOT NULL,
          content      TEXT NOT NULL,
          url          TEXT,
          timestamp    INTEGER NOT NULL,
          metadata     TEXT NOT NULL DEFAULT '{}',
          fingerprint  TEXT NOT NULL DEFAULT '',
          created_at   INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
        CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(source, document_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_timestamp ON chunks(timestamp DESC);
      `);

      // Cascade delete from chunks -> chunk_embeddings
      // (chunk_embeddings is a virtual table, no FK; we trigger manually)
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
          embedding float[${this.dimensions}]
        );
      `);

      // FTS5 contentless table for keyword search. We mirror chunks.id as
      // the FTS rowid and keep the content there too (contentless 'content='
      // mode is faster but reduces flexibility; we keep flexibility for now).
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
          title,
          content,
          tokenize = 'unicode61 remove_diacritics 2'
        );
      `);

      // Cascade delete: chunks → chunk_embeddings + chunk_fts
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_after_delete
        AFTER DELETE ON chunks
        BEGIN
          DELETE FROM chunk_embeddings WHERE rowid = OLD.id;
          DELETE FROM chunk_fts WHERE rowid = OLD.id;
        END;
      `);

      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return;
    }

    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${currentVersion} is newer than supported ${SCHEMA_VERSION}. Upgrade remembr.`,
      );
    }

    // v1 → v2: add fingerprint column for incremental indexing
    if (currentVersion < 2) {
      this.db.exec(`
        ALTER TABLE chunks ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
      `);
      this.db.exec('PRAGMA user_version = 2');
    }

    // v2 → v3: add FTS5 keyword index + rebuild trigger
    if (currentVersion < 3) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
          title,
          content,
          tokenize = 'unicode61 remove_diacritics 2'
        );
      `);
      // Backfill FTS index from existing chunks
      this.db.exec(`
        INSERT INTO chunk_fts (rowid, title, content)
        SELECT id, title, content FROM chunks;
      `);
      // Replace the cascade trigger to also clean FTS rows
      this.db.exec('DROP TRIGGER IF EXISTS chunks_after_delete');
      this.db.exec(`
        CREATE TRIGGER chunks_after_delete
        AFTER DELETE ON chunks
        BEGIN
          DELETE FROM chunk_embeddings WHERE rowid = OLD.id;
          DELETE FROM chunk_fts WHERE rowid = OLD.id;
        END;
      `);
      this.db.exec('PRAGMA user_version = 3');
    }
  }
}

function toFloat32Buffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/**
 * Convert a free-form user query into a safe FTS5 MATCH expression.
 *
 * Strategy: extract alphanumeric/Unicode word tokens (drop FTS5 metachars),
 * quote each, and OR them. This matches if any token appears, which keeps
 * recall high; ranking handles relevance.
 */
function toFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

function rowToResult(row: SearchRow): SearchResult {
  return {
    id: row.id,
    source: row.source,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    title: row.title,
    content: row.content,
    url: row.url,
    timestamp: row.timestamp,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    distance: row.distance,
  };
}
