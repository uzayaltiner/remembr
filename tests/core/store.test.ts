import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChunkInput, Store } from '../../src/core/store.js';

const DIMS = 4; // small dim for tests; production uses 768

function vec(...values: number[]): number[] {
  // Pad / truncate to DIMS
  const out = new Array(DIMS).fill(0);
  for (let i = 0; i < Math.min(values.length, DIMS); i++) out[i] = values[i];
  return out;
}

function chunk(overrides: Partial<ChunkInput> = {}): ChunkInput {
  return {
    source: 'test',
    documentId: 'doc-1',
    chunkIndex: 0,
    title: 'Test',
    content: 'Test content',
    url: null,
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe('Store', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'localbrain-test-'));
    store = new Store({ path: join(tmpDir, 'test.db'), dimensions: DIMS });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('upsertChunk', () => {
    it('inserts a chunk + embedding and returns its id', () => {
      const id = store.upsertChunk(chunk(), vec(1, 0, 0, 0));
      expect(id).toBeGreaterThan(0);
      expect(store.count()).toBe(1);
    });

    it('rejects mismatched embedding dimensions', () => {
      expect(() => store.upsertChunk(chunk(), [1, 0, 0])).toThrow(/dimension mismatch/i);
    });

    it('persists multiple chunks under different ids', () => {
      const a = store.upsertChunk(chunk({ chunkIndex: 0 }), vec(1, 0, 0, 0));
      const b = store.upsertChunk(chunk({ chunkIndex: 1 }), vec(0, 1, 0, 0));
      expect(b).toBeGreaterThan(a);
      expect(store.count()).toBe(2);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      store.upsertChunk(
        chunk({ documentId: 'doc-rust', title: 'Rust async' }),
        vec(1, 0, 0, 0),
      );
      store.upsertChunk(
        chunk({ documentId: 'doc-tokio', title: 'Tokio runtime' }),
        vec(0.9, 0.1, 0, 0),
      );
      store.upsertChunk(
        chunk({ documentId: 'doc-cooking', title: 'Pasta recipe' }),
        vec(0, 0, 1, 0),
      );
    });

    it('returns nearest chunks first', () => {
      const results = store.search(vec(1, 0, 0, 0), { limit: 3 });
      expect(results).toHaveLength(3);
      expect(results[0]?.title).toBe('Rust async');
      expect(results[1]?.title).toBe('Tokio runtime');
      expect(results[2]?.title).toBe('Pasta recipe');
    });

    it('respects limit', () => {
      const results = store.search(vec(1, 0, 0, 0), { limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('returns distances in ascending order', () => {
      const results = store.search(vec(1, 0, 0, 0), { limit: 3 });
      const distances = results.map((r) => r.distance);
      for (let i = 1; i < distances.length; i++) {
        const prev = distances[i - 1] ?? 0;
        const cur = distances[i] ?? 0;
        expect(cur).toBeGreaterThanOrEqual(prev);
      }
    });

    it('deserializes metadata back to an object', () => {
      store.upsertChunk(
        chunk({
          documentId: 'doc-meta',
          title: 'With metadata',
          metadata: { author: 'uzay', tags: ['a', 'b'] },
        }),
        vec(0.5, 0.5, 0, 0),
      );
      const results = store.search(vec(0.5, 0.5, 0, 0), { limit: 1 });
      expect(results[0]?.metadata).toEqual({ author: 'uzay', tags: ['a', 'b'] });
    });

    it('filters by source when provided', () => {
      store.upsertChunk(
        chunk({ source: 'browser', title: 'Browser hit' }),
        vec(1, 0, 0, 0),
      );
      const results = store.search(vec(1, 0, 0, 0), { limit: 10, source: 'browser' });
      expect(results.every((r) => r.source === 'browser')).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it('rejects mismatched query dimensions', () => {
      expect(() => store.search([1, 0, 0])).toThrow(/dimension mismatch/i);
    });
  });

  describe('deleteBySource', () => {
    it('removes chunks for a source and cascades to embeddings', () => {
      store.upsertChunk(chunk({ source: 'markdown' }), vec(1, 0, 0, 0));
      store.upsertChunk(chunk({ source: 'markdown', chunkIndex: 1 }), vec(0, 1, 0, 0));
      store.upsertChunk(chunk({ source: 'browser' }), vec(0, 0, 1, 0));

      const deleted = store.deleteBySource('markdown');
      expect(deleted).toBe(2);
      expect(store.count()).toBe(1);
      expect(store.count('markdown')).toBe(0);
      expect(store.count('browser')).toBe(1);

      // Embeddings should also be gone — search shouldn't find them
      const results = store.search(vec(1, 0, 0, 0), { limit: 10 });
      expect(results.every((r) => r.source === 'browser')).toBe(true);
    });
  });

  describe('count', () => {
    it('counts all chunks', () => {
      expect(store.count()).toBe(0);
      store.upsertChunk(chunk(), vec(1, 0, 0, 0));
      expect(store.count()).toBe(1);
    });

    it('counts by source', () => {
      store.upsertChunk(chunk({ source: 'a' }), vec(1, 0, 0, 0));
      store.upsertChunk(chunk({ source: 'b' }), vec(0, 1, 0, 0));
      expect(store.count('a')).toBe(1);
      expect(store.count('b')).toBe(1);
      expect(store.count('c')).toBe(0);
    });
  });

  describe('fingerprint + incremental ops', () => {
    it('returns null fingerprint for unknown documents', () => {
      expect(store.getDocumentFingerprint('test', 'nonexistent')).toBeNull();
    });

    it('returns the stored fingerprint after upsert', () => {
      store.upsertChunk(
        chunk({ documentId: 'doc-a', fingerprint: 'fp-1' }),
        vec(1, 0, 0, 0),
      );
      expect(store.getDocumentFingerprint('test', 'doc-a')).toBe('fp-1');
    });

    it('lists distinct document_ids per source', () => {
      store.upsertChunk(chunk({ documentId: 'd1', chunkIndex: 0 }), vec(1, 0, 0, 0));
      store.upsertChunk(chunk({ documentId: 'd1', chunkIndex: 1 }), vec(0, 1, 0, 0));
      store.upsertChunk(chunk({ documentId: 'd2', chunkIndex: 0 }), vec(0, 0, 1, 0));
      const ids = store.listDocumentIds('test').sort();
      expect(ids).toEqual(['d1', 'd2']);
    });

    it('deleteDocument removes only that document', () => {
      store.upsertChunk(chunk({ documentId: 'keep' }), vec(1, 0, 0, 0));
      store.upsertChunk(chunk({ documentId: 'drop', chunkIndex: 0 }), vec(0, 1, 0, 0));
      store.upsertChunk(chunk({ documentId: 'drop', chunkIndex: 1 }), vec(0, 0, 1, 0));

      const removed = store.deleteDocument('test', 'drop');
      expect(removed).toBe(2);
      expect(store.count()).toBe(1);
      expect(store.listDocumentIds('test')).toEqual(['keep']);
    });

    it('cascades embeddings when a single document is deleted', () => {
      store.upsertChunk(chunk({ documentId: 'gone' }), vec(1, 0, 0, 0));
      store.deleteDocument('test', 'gone');
      const results = store.search(vec(1, 0, 0, 0), { limit: 10 });
      expect(results.find((r) => r.documentId === 'gone')).toBeUndefined();
    });
  });

  describe('persistence', () => {
    it('survives close/reopen', () => {
      const path = join(tmpDir, 'persist.db');
      const s1 = new Store({ path, dimensions: DIMS });
      s1.upsertChunk(chunk({ title: 'persisted' }), vec(1, 0, 0, 0));
      s1.close();

      const s2 = new Store({ path, dimensions: DIMS });
      expect(s2.count()).toBe(1);
      const results = s2.search(vec(1, 0, 0, 0), { limit: 1 });
      expect(results[0]?.title).toBe('persisted');
      s2.close();
    });
  });

  describe('upsertChunks (batch)', () => {
    it('inserts every item in a single transaction and returns ids in order', () => {
      const ids = store.upsertChunks([
        { chunk: chunk({ documentId: 'a', chunkIndex: 0 }), vector: vec(1, 0, 0, 0) },
        { chunk: chunk({ documentId: 'b', chunkIndex: 0 }), vector: vec(0, 1, 0, 0) },
        { chunk: chunk({ documentId: 'c', chunkIndex: 0 }), vector: vec(0, 0, 1, 0) },
      ]);
      expect(ids).toHaveLength(3);
      expect(ids[1]).toBeGreaterThan(ids[0] ?? 0);
      expect(store.count()).toBe(3);
    });

    it('rolls back the entire batch on a single dimension error', () => {
      expect(() =>
        store.upsertChunks([
          { chunk: chunk({ documentId: 'good', chunkIndex: 0 }), vector: vec(1, 0, 0, 0) },
          // bad: only 3 dims
          { chunk: chunk({ documentId: 'bad', chunkIndex: 0 }), vector: [1, 0, 0] },
        ]),
      ).toThrow(/dimension mismatch/i);
      // No partial inserts — transaction should have rolled back.
      expect(store.count()).toBe(0);
    });

    it('returns [] for an empty batch', () => {
      expect(store.upsertChunks([])).toEqual([]);
    });
  });

  describe('searchHybrid (RRF)', () => {
    beforeEach(() => {
      store.upsertChunk(
        chunk({ documentId: 'r', title: 'Rust async', content: 'tokio executor primer' }),
        vec(1, 0, 0, 0),
      );
      store.upsertChunk(
        chunk({ documentId: 't', title: 'Tokio runtime', content: 'green thread scheduler' }),
        vec(0.9, 0.1, 0, 0),
      );
      store.upsertChunk(
        chunk({ documentId: 'p', title: 'Pasta recipe', content: 'boil water add salt' }),
        vec(0, 0, 1, 0),
      );
    });

    it('returns semantic-only hits when the keyword query has no matches', () => {
      const results = store.searchHybrid(vec(1, 0, 0, 0), '   ', { limit: 3 });
      expect(results).toHaveLength(3);
      expect(results[0]?.title).toBe('Rust async');
    });

    it('boosts a chunk that matches both the vector and the FTS query', () => {
      // 'tokio' appears only in 'Rust async' content — so it both matches FTS
      // and is the top semantic hit. Should rank first.
      const results = store.searchHybrid(vec(1, 0, 0, 0), 'tokio', { limit: 3 });
      expect(results[0]?.documentId).toBe('r');
    });

    it('surfaces FTS-only hits even when their vector is far away', () => {
      // 'pasta' is semantically the cooking note; query vector points at rust.
      // Without keyword fusion the cooking note would rank last.
      const results = store.searchHybrid(vec(1, 0, 0, 0), 'pasta', { limit: 3 });
      expect(results.some((r) => r.documentId === 'p')).toBe(true);
    });

    it('respects the source filter', () => {
      store.upsertChunk(
        chunk({
          source: 'browser',
          documentId: 'br',
          title: 'Browser hit',
          content: 'rust async tokio',
        }),
        vec(1, 0, 0, 0),
      );
      const results = store.searchHybrid(vec(1, 0, 0, 0), 'rust', {
        limit: 10,
        source: 'browser',
      });
      expect(results).not.toHaveLength(0);
      expect(results.every((r) => r.source === 'browser')).toBe(true);
    });

    it('survives queries that contain only FTS metacharacters', () => {
      // No alphanumeric tokens — FTS should silently fall back to semantic.
      const results = store.searchHybrid(vec(1, 0, 0, 0), '!!!', { limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('rejects mismatched query dimensions', () => {
      expect(() => store.searchHybrid([1, 0, 0], 'rust')).toThrow(/dimension mismatch/i);
    });
  });

  describe('dimension probe on reopen', () => {
    it('throws StoreOpenError when the embedder dim no longer matches the stored vectors', () => {
      const path = join(tmpDir, 'dim.db');
      const s1 = new Store({ path, dimensions: 4 });
      s1.upsertChunk(chunk({ documentId: 'd' }), [1, 0, 0, 0]);
      s1.close();

      expect(() => new Store({ path, dimensions: 8 })).toThrow(
        /dimension mismatch/i,
      );
    });
  });
});
