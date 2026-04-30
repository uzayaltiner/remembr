/**
 * Failure-mode tests for Store.open: corrupt files, integrity_check
 * failures, and the StoreOpenError surface.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, StoreOpenError } from '../../src/core/store.js';

const DIMS = 4;

describe('Store recovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'remembr-rec-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws StoreOpenError when the file is not a SQLite database', () => {
    const path = join(tmpDir, 'garbage.db');
    writeFileSync(path, 'not actually a sqlite file at all');
    let caught: unknown;
    try {
      const s = new Store({ path, dimensions: DIMS });
      s.close();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreOpenError);
    expect((caught as StoreOpenError).kind).toMatch(/integrity|open/);
    expect((caught as Error).message).toMatch(/repair/i);
  });

  it('opens a fresh database without throwing', () => {
    const path = join(tmpDir, 'fresh.db');
    const s = new Store({ path, dimensions: DIMS });
    expect(s.count()).toBe(0);
    s.close();
  });
});
