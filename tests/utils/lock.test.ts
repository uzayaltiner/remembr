/**
 * Advisory write-lock semantics. The module reads PATHS.home eagerly
 * via the lockfile path constant, so we point REMEMBR_HOME at a tmpdir
 * BEFORE the test file is even loaded — that's why this file does the
 * mkdir + env mutation at module top, not in beforeEach.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const TMP = join(tmpdir(), `remembr-lock-${process.pid}-${Date.now()}`);
mkdirSync(TMP, { recursive: true });
process.env.REMEMBR_HOME = TMP;

const { acquireWriteLock } = await import('../../src/utils/lock.js');

const LOCK_PATH = join(TMP, 'sync.lock');

describe('acquireWriteLock', () => {
  beforeEach(() => {
    if (existsSync(LOCK_PATH)) rmSync(LOCK_PATH);
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('creates the lockfile with the current PID and removes it on release', () => {
    const lock = acquireWriteLock();
    expect(existsSync(LOCK_PATH)).toBe(true);
    expect(readFileSync(LOCK_PATH, 'utf-8').trim()).toBe(String(process.pid));
    lock.release();
    expect(existsSync(LOCK_PATH)).toBe(false);
  });

  it('reclaims a stale lock whose PID is dead', () => {
    // pid 0 is reserved/dead from process.kill's perspective.
    writeFileSync(LOCK_PATH, '0');
    const lock = acquireWriteLock();
    expect(readFileSync(LOCK_PATH, 'utf-8').trim()).toBe(String(process.pid));
    lock.release();
  });

  it('is re-entrant within the same process', () => {
    const outer = acquireWriteLock();
    // Same process, same module instance — second acquire is a no-op.
    const inner = acquireWriteLock();
    expect(existsSync(LOCK_PATH)).toBe(true);
    inner.release();
    // Lockfile must NOT have been deleted by the inner release.
    expect(existsSync(LOCK_PATH)).toBe(true);
    outer.release();
    expect(existsSync(LOCK_PATH)).toBe(false);
  });
});
