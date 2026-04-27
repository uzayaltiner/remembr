/**
 * Spike: does bun:sqlite + sqlite-vec actually work?
 *
 * This is the make-or-break test for the Bun runtime decision in the brief.
 * If it works, we keep Bun. If it doesn't, we fall back to Node + better-sqlite3
 * and lose the single-binary distribution path.
 *
 * Tests:
 *   1. Open a bun:sqlite database
 *   2. Load sqlite-vec extension
 *   3. Create a vec0 virtual table
 *   4. Insert a vector
 *   5. Run a kNN query
 *   6. Verify the result
 */

import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bun ships a stripped sqlite without dynamic extension support.
// Switch to system / Homebrew sqlite which supports loadExtension.
const BREW_SQLITE = '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib';
if (existsSync(BREW_SQLITE)) {
  Database.setCustomSQLite(BREW_SQLITE);
  console.log(`Using custom sqlite: ${BREW_SQLITE}\n`);
}

const tmpDir = mkdtempSync(join(tmpdir(), 'remembr-spike-'));
const dbPath = join(tmpDir, 'spike.db');

console.log('=== Bun + sqlite-vec spike ===');
console.log(`DB:  ${dbPath}`);

try {
  console.log('\n1. Opening database...');
  const db = new Database(dbPath);
  console.log('   ✓ open');

  console.log('\n2. Loading sqlite-vec extension...');
  const extPath = sqliteVec.getLoadablePath();
  console.log(`   path: ${extPath}`);
  db.loadExtension(extPath);
  console.log('   ✓ loaded');

  console.log('\n3. Creating vec0 virtual table (4-dim test)...');
  db.exec(`
    CREATE VIRTUAL TABLE test_vecs USING vec0(
      embedding float[4]
    );
  `);
  console.log('   ✓ created');

  console.log('\n4. Inserting test vectors...');
  const insert = db.prepare('INSERT INTO test_vecs(rowid, embedding) VALUES (?, ?)');
  const toBuf = (vec: number[]) => Buffer.from(new Float32Array(vec).buffer);
  // Use BigInt for rowid as we learned with better-sqlite3 (vec0 wants strict INTEGER)
  insert.run(1n, toBuf([1, 0, 0, 0]));
  insert.run(2n, toBuf([0.9, 0.1, 0, 0]));
  insert.run(3n, toBuf([0, 0, 1, 0]));
  console.log('   ✓ 3 rows inserted');

  console.log('\n5. Running kNN query for [1,0,0,0]...');
  const search = db.prepare(`
    SELECT rowid, distance
    FROM test_vecs
    WHERE embedding MATCH ? AND k = ?
    ORDER BY distance
  `);
  const rows = search.all(toBuf([1, 0, 0, 0]), 3) as Array<{ rowid: number; distance: number }>;

  console.log('   results:');
  for (const r of rows) {
    console.log(`     rowid=${r.rowid}  distance=${r.distance.toFixed(4)}`);
  }

  console.log('\n6. Verifying ranking...');
  if (rows.length !== 3) throw new Error(`expected 3 rows, got ${rows.length}`);
  if (rows[0]?.rowid !== 1) throw new Error(`expected rowid 1 first, got ${rows[0]?.rowid}`);
  if (rows[1]?.rowid !== 2) throw new Error(`expected rowid 2 second, got ${rows[1]?.rowid}`);
  if (rows[2]?.rowid !== 3) throw new Error(`expected rowid 3 third, got ${rows[2]?.rowid}`);
  console.log('   ✓ ranking matches expected order');

  console.log('\n7. Testing FTS5 (hybrid search dependency)...');
  db.exec(`
    CREATE VIRTUAL TABLE fts_test USING fts5(content);
  `);
  db.prepare('INSERT INTO fts_test(content) VALUES (?)').run('rust async runtime');
  db.prepare('INSERT INTO fts_test(content) VALUES (?)').run('italian pasta recipe');
  const fts = db.prepare(`SELECT rowid, content FROM fts_test WHERE content MATCH ?`).all('rust');
  console.log(`   ✓ FTS5 query returned ${fts.length} row(s)`);

  db.close();
  console.log('\n✅ ALL CHECKS PASSED — Bun + sqlite-vec + FTS5 works.');
  console.log('   Decision: keep Bun. Migrate Store to bun:sqlite.');
} catch (err) {
  console.error('\n❌ FAILED:', err instanceof Error ? err.message : err);
  console.error('\n   Decision: fall back to Node + better-sqlite3.');
  process.exit(1);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
