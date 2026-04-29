/**
 * Full Disk Access detection helpers (macOS).
 *
 * macOS gates several user databases (Apple Notes, Calendar, Mail) behind
 * the "Full Disk Access" privacy slot. The terminal application running
 * remembr must be on the FDA allow-list before these plugins can read.
 *
 * We test for FDA by trying to open the Apple Notes database read-only —
 * the most reliable signal because:
 *   - Notes is installed on every macOS machine
 *   - The path is stable across versions
 *   - Failure mode is a clear EPERM/EACCES, not a missing file
 *
 * If the test throws ENOENT we treat it as "not on macOS or Notes never
 * opened" — out of scope, return null.
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NOTESTORE_PATH = join(
  homedir(),
  'Library',
  'Group Containers',
  'group.com.apple.notes',
  'NoteStore.sqlite',
);

const FDA_DEEPLINK = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

export type FdaStatus = 'granted' | 'denied' | 'unavailable';

/**
 * Probe Full Disk Access by attempting a read-only open of the Notes DB.
 *
 *   - 'granted'      → terminal is on the FDA allow-list
 *   - 'denied'       → file exists but the open errored with EPERM/EACCES
 *   - 'unavailable'  → not on macOS, or Notes has never been opened
 */
export function checkFullDiskAccess(): FdaStatus {
  if (!existsSync(NOTESTORE_PATH)) {
    return 'unavailable';
  }
  try {
    const fd = openSync(NOTESTORE_PATH, 'r');
    closeSync(fd);
    return 'granted';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return 'denied';
    // ENOENT or anything else: treat as unavailable so the caller doesn't
    // mislead the user with a "denied" prompt.
    return 'unavailable';
  }
}

/**
 * Open System Settings → Privacy & Security → Full Disk Access via the
 * native deeplink. macOS only.
 *
 * The promise resolves once the `open` process exits — it does NOT wait
 * for the user to grant access. Callers should re-check `checkFullDiskAccess`
 * after a UI prompt.
 */
export function openFdaSystemSettings(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('open', [FDA_DEEPLINK], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`open exited with code ${code}`));
    });
  });
}

/**
 * Convenience wait-for-keypress on stdin. Resolves when the user hits
 * Enter (or any line). Caller is expected to print a prompt first.
 */
export function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const onData = (): void => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}
