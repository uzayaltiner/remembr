/**
 * Claude Code desktop helpers (macOS).
 *
 * MCP servers are only loaded when Claude Code launches, so after we
 * register remembr the user has to restart Claude. These helpers let
 * the setup TUI offer one-click "open" / "restart" instead of asking
 * the user to do it themselves.
 *
 * Linux / Windows fall through with isAvailable() === false; callers
 * skip the buttons.
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Bundle ID of Anthropic's desktop Claude Code app. */
const CLAUDE_APP_NAME = 'Claude';

/** Whether Claude-app helpers can run on this OS. */
export function isAvailable(): boolean {
  return platform() === 'darwin';
}

/**
 * Check whether Claude Code is currently running.
 *
 * Uses `pgrep -lif <name>` against the running process list. Returns
 * false on non-macOS or when pgrep itself fails.
 */
export async function isClaudeRunning(): Promise<boolean> {
  if (!isAvailable()) return false;
  try {
    // -lif: case-insensitive full-cmdline match. We pass the bundle name —
    // matches both `Claude.app/Contents/MacOS/Claude` and any subprocess.
    const { stdout } = await execFileAsync('pgrep', ['-lif', CLAUDE_APP_NAME], {
      timeout: 2000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Ask Claude Code to quit gracefully via AppleScript. Returns once
 * the process is no longer running (with a short polling loop) or
 * the timeout elapses.
 */
export async function quitClaude(timeoutMs = 5000): Promise<void> {
  if (!isAvailable()) return;
  try {
    await execFileAsync('osascript', ['-e', `tell application "${CLAUDE_APP_NAME}" to quit`], {
      timeout: 3000,
    });
  } catch {
    // App may not be running, or AppleScript failed; either way fall through
    // to the polling loop below — if Claude isn't running, the loop exits
    // immediately.
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isClaudeRunning())) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Launch Claude Code via `open -a`. `open` returns as soon as the
 * launch is dispatched, so the `await` is short-lived even though the
 * GUI app keeps running.
 */
export async function openClaude(): Promise<void> {
  if (!isAvailable()) return;
  await execFileAsync('open', ['-a', CLAUDE_APP_NAME]);
}

/**
 * Convenience: quit (if running) and re-launch.
 */
export async function restartClaude(): Promise<void> {
  if (!isAvailable()) return;
  if (await isClaudeRunning()) await quitClaude();
  await openClaude();
}
