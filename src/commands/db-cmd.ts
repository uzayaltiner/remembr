/**
 * `remembr db repair` — recover from a corrupt or otherwise unopenable
 * SQLite store. Renames db.sqlite{,-wal,-shm} to a timestamped quarantine
 * filename so the next sync can rebuild the index from scratch.
 *
 * The user's source data (Apple Notes, files on disk, …) is untouched —
 * the index is reproducible.
 */

import { existsSync, renameSync } from 'node:fs';
import { PATHS } from '../config/paths.js';

export function runDbRepair(): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const suffixes = ['', '-wal', '-shm'];

  const moved: string[] = [];
  for (const suffix of suffixes) {
    const src = `${PATHS.database}${suffix}`;
    if (!existsSync(src)) continue;
    const dst = `${PATHS.database}.corrupt-${ts}${suffix}`;
    try {
      renameSync(src, dst);
      moved.push(dst);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not move ${src} → ${dst}: ${msg}`);
    }
  }

  if (moved.length === 0) {
    console.log('ℹ No database files at', PATHS.database, '— nothing to repair.');
    return;
  }

  console.log('✓ Quarantined the existing index:');
  for (const path of moved) {
    console.log(`    ${path}`);
  }
  console.log('');
  console.log('Next: remembr sync   (rebuilds the index from your sources)');
  console.log('');
  console.log('Once sync succeeds you can delete the quarantine files manually.');
}
