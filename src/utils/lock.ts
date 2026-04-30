/**
 * Best-effort advisory file lock for serializing write commands
 * (`remembr sync`, `remembr index`) within a single ~/.remembr install.
 *
 * Strategy: create lockfile with O_EXCL. The file's body is the holding
 * PID. If the lockfile already exists we check whether that PID is still
 * alive and reject (or steal a stale lock).
 *
 * Not a hard mutex — two `remembr` processes on different machines
 * sharing the same dir over a network FS would still race — but covers
 * the realistic case (two terminals on one Mac).
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config/paths.js';

const LOCK_PATH = join(PATHS.home, 'sync.lock');

export class LockBusyError extends Error {
  constructor(
    public readonly holderPid: number,
    public readonly path: string,
  ) {
    super(
      `Another remembr process (pid ${holderPid}) is currently holding ${path}.\n  Wait for it to finish, or remove the lockfile manually if it is stale.`,
    );
    this.name = 'LockBusyError';
  }
}

export interface AcquiredLock {
  release: () => void;
}

/**
 * In-process re-entrancy: if `runSync` (or any other write command) has
 * already taken the lock, child code paths like `runIndex` see this flag
 * and skip a second acquire instead of deadlocking on EEXIST against
 * their own parent.
 */
let heldByThisProcess = false;
const NOOP_LOCK: AcquiredLock = { release: () => {} };

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 = no-op, only checks delivery permission and existence.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is owned by someone else — still
    // counts as alive for our purposes.
    return code === 'EPERM';
  }
}

/**
 * Acquire the write-lock. Throws `LockBusyError` if another live process
 * holds it. Stale locks (PID not running) are silently reclaimed.
 */
export function acquireWriteLock(): AcquiredLock {
  if (heldByThisProcess) return NOOP_LOCK;

  let fd: number;
  try {
    fd = openSync(LOCK_PATH, 'wx', 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;

    let holder = 0;
    try {
      holder = Number.parseInt(readFileSync(LOCK_PATH, 'utf-8').trim(), 10);
    } catch {
      // Couldn't read PID — treat as stale.
      holder = 0;
    }

    if (isProcessAlive(holder)) {
      throw new LockBusyError(holder, LOCK_PATH);
    }

    // Stale lock: nuke and retry once. If a real holder grabs it between
    // the unlink and our re-open we'll see EEXIST again and bail.
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      // best-effort
    }
    fd = openSync(LOCK_PATH, 'wx', 0o600);
  }

  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }

  heldByThisProcess = true;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    heldByThisProcess = false;
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      // best-effort: file may already be gone
    }
  };

  // Belt-and-braces: clean up when the process exits without an explicit
  // release call. Using `process.once` avoids piling listeners across
  // repeated acquireWriteLock calls in the same run.
  process.once('exit', release);

  return { release };
}
