/**
 * Setup state machine persistence.
 *
 * `remembr setup` is multi-phase: each phase records completion in
 * ~/.remembr/.setup-state.json so a second run resumes where the first
 * left off. The most common reason for a re-run is FDA: the first run
 * detects "denied", prints instructions, and exits. The user grants
 * FDA, restarts the terminal, and re-runs setup — at which point we
 * skip every phase that's already done and re-probe FDA.
 *
 * The state file is small, JSON, and entirely safe to delete: a deleted
 * state file just means setup will run every phase again.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PATHS } from './paths.js';
import { ensureHome } from './settings.js';

export type SetupPhase = 'bootstrap' | 'paths' | 'fda' | 'mcp' | 'sync';

interface PhaseResult {
  /** True once the phase ran to completion (or was deliberately skipped). */
  completed: boolean;
  /** ISO timestamp of the most recent attempt — useful for debugging. */
  attemptedAt?: string;
  /** Phase-specific machine-readable detail (e.g. fda: 'granted' | 'denied'). */
  detail?: string;
}

interface SetupState {
  /** Schema version of this file — bumped on incompatible field changes. */
  version: 1;
  phases: Record<SetupPhase, PhaseResult>;
}

const EMPTY: SetupState = {
  version: 1,
  phases: {
    bootstrap: { completed: false },
    paths: { completed: false },
    fda: { completed: false },
    mcp: { completed: false },
    sync: { completed: false },
  },
};

export function readSetupState(): SetupState {
  if (!existsSync(PATHS.setupState)) {
    return cloneState(EMPTY);
  }
  try {
    const raw = readFileSync(PATHS.setupState, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SetupState>;
    if (parsed.version !== 1) return cloneState(EMPTY);
    // Merge with EMPTY so newly-introduced phases get a default slot.
    return {
      version: 1,
      phases: { ...EMPTY.phases, ...(parsed.phases ?? {}) },
    };
  } catch {
    // Corrupt file — reset rather than crash.
    return cloneState(EMPTY);
  }
}

export function writeSetupState(state: SetupState): void {
  ensureHome();
  writeFileSync(PATHS.setupState, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export function markPhase(phase: SetupPhase, completed: boolean, detail?: string): SetupState {
  const state = readSetupState();
  state.phases[phase] = {
    completed,
    attemptedAt: new Date().toISOString(),
    detail,
  };
  writeSetupState(state);
  return state;
}

export function resetSetupState(): void {
  if (existsSync(PATHS.setupState)) {
    writeSetupState(cloneState(EMPTY));
  }
}

function cloneState(state: SetupState): SetupState {
  return {
    version: state.version,
    phases: {
      bootstrap: { ...state.phases.bootstrap },
      paths: { ...state.phases.paths },
      fda: { ...state.phases.fda },
      mcp: { ...state.phases.mcp },
      sync: { ...state.phases.sync },
    },
  };
}
