import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  markPhase,
  readSetupState,
  resetSetupState,
  writeSetupState,
} from '../../src/config/setup-state.js';

describe('setup-state', () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'remembr-setup-state-'));
    originalHome = process.env.REMEMBR_HOME;
    process.env.REMEMBR_HOME = tmp;
    // Settings module caches PATHS; the path constants are lazily computed
    // per call though, so swapping env between tests is safe.
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.REMEMBR_HOME;
    else process.env.REMEMBR_HOME = originalHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an EMPTY state when no file exists', () => {
    const state = readSetupState();
    expect(state.version).toBe(1);
    expect(state.phases.bootstrap.completed).toBe(false);
    expect(state.phases.fda.completed).toBe(false);
  });

  it('round-trips through write + read', () => {
    const state = readSetupState();
    state.phases.bootstrap.completed = true;
    state.phases.bootstrap.detail = 'ok';
    writeSetupState(state);

    const round = readSetupState();
    expect(round.phases.bootstrap.completed).toBe(true);
    expect(round.phases.bootstrap.detail).toBe('ok');
  });

  it('markPhase writes timestamp + detail and persists across reads', () => {
    markPhase('fda', false, 'denied');
    const state = readSetupState();
    expect(state.phases.fda.completed).toBe(false);
    expect(state.phases.fda.detail).toBe('denied');
    expect(typeof state.phases.fda.attemptedAt).toBe('string');
  });

  it('returns EMPTY when version mismatches (forward-incompatible reset)', () => {
    const state = readSetupState();
    state.phases.paths.completed = true;
    writeSetupState({ ...state, version: 99 as 1 });

    const round = readSetupState();
    expect(round.version).toBe(1);
    expect(round.phases.paths.completed).toBe(false);
  });

  it('resetSetupState wipes saved phase state', () => {
    markPhase('mcp', true, 'installed:1');
    expect(readSetupState().phases.mcp.completed).toBe(true);

    resetSetupState();
    expect(readSetupState().phases.mcp.completed).toBe(false);
  });

  it('survives a corrupt state file by returning EMPTY', () => {
    markPhase('bootstrap', true);
    // Corrupt the file by overwriting it with junk.
    writeSetupState({} as never);
    // Forward-incompatible / corrupt → empty state.
    expect(readSetupState().phases.bootstrap.completed).toBe(false);
  });
});
