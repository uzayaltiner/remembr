/**
 * `remembr fda` — Full Disk Access status + repair flow.
 *
 * Useful as a sanity check (Did I grant FDA properly?) and as the
 * place we redirect users to when `setup` detects FDA is missing.
 */

import { type FdaStatus, checkFullDiskAccess, openFdaSystemSettings } from '../utils/fda.js';

export interface RunFdaOptions {
  /** Open System Settings → Privacy → Full Disk Access automatically. */
  open?: boolean;
}

export async function runFda(options: RunFdaOptions = {}): Promise<void> {
  const status: FdaStatus = checkFullDiskAccess();

  switch (status) {
    case 'granted':
      console.log('✓ Full Disk Access is granted to this terminal.');
      console.log('  Apple Notes, Calendar, and Mail plugins will work.');
      return;

    case 'unavailable':
      console.log('ℹ Full Disk Access check: not applicable on this machine.');
      console.log('  Apple Notes / Calendar / Mail plugins will be skipped.');
      console.log('  (Either not on macOS, or those apps were never opened.)');
      return;

    case 'denied':
      console.log('✗ Full Disk Access is NOT granted to this terminal.');
      console.log('');
      console.log('To fix:');
      console.log('  1. System Settings → Privacy & Security → Full Disk Access');
      console.log('  2. Add your terminal app: Terminal / iTerm / Warp / Ghostty / …');
      console.log('  3. Quit the terminal completely (Cmd+Q) and re-open it');
      console.log('     macOS only applies new TCC permissions to NEW processes.');
      console.log('  4. Re-run: remembr fda');
      console.log('');
      if (options.open) {
        console.log('Opening System Settings…');
        try {
          await openFdaSystemSettings();
        } catch {
          console.log('  (Could not auto-open. Open System Settings manually.)');
        }
      } else {
        console.log('Tip: pass --open to launch System Settings now.');
      }
      process.exit(1);
  }
}
