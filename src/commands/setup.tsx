/**
 * `remembr setup` — guided installation.
 *
 * In interactive mode (default) this renders an Ink TUI: a state machine
 * across paths / apple / fda / mcp / sync phases, with results persisted
 * in ~/.remembr/.setup-state.json so a re-run resumes where it left off.
 *
 * In `--yes` mode we skip Ink entirely and run a headless equivalent
 * that accepts every default. The headless path is scriptable, doesn't
 * require a TTY, and is the supported way to set up remembr in CI.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink';
import React from 'react';
import {
  type BrainConfig,
  configExists,
  ensureHome,
  readConfig,
  writeConfig,
} from '../config/settings.js';
import { markPhase, resetSetupState } from '../config/setup-state.js';
import { SetupView } from '../ui/views/SetupView.js';
import { isAvailable as claudeAvailable, isClaudeRunning } from '../utils/claude-app.js';
import { type FdaStatus, checkFullDiskAccess } from '../utils/fda.js';
import { runInit } from './init.js';
import { detectInstalledClients, installMcpFor } from './mcp-install.js';
import { runSync } from './sync-cmd.js';

export interface SetupOptions {
  /** Skip every prompt and accept defaults. Useful for CI / scripted use. */
  yes?: boolean;
  /** Wipe the saved phase state before starting (run every phase from scratch). */
  reset?: boolean;
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  if (options.reset) resetSetupState();

  if (options.yes) {
    await runSetupHeadless();
    return;
  }

  const ink = render(<SetupView reset={options.reset} />);
  await ink.waitUntilExit();
}

/**
 * Non-interactive setup. Accepts every default, no TTY required.
 * Runs all 5 phases sequentially and prints plain text progress.
 */
async function runSetupHeadless(): Promise<void> {
  console.log('▸ remembr setup (non-interactive)');

  if (!configExists()) {
    ensureHome();
    runInit({ quiet: true });
  }
  markPhase('bootstrap', true);

  let config = readConfig();

  const documents = join(homedir(), 'Documents');
  config = addPath(config, 'fs', documents);
  config = addPath(config, 'pdf', documents);
  writeConfig(config);
  markPhase('paths', true, 'configured');
  console.log(`✓ Indexing ${documents}`);

  const fda: FdaStatus = checkFullDiskAccess();
  if (fda === 'granted') {
    markPhase('fda', true, 'granted');
    console.log('✓ Full Disk Access granted');
  } else if (fda === 'unavailable') {
    config = setEnabled(config, 'apple-notes', false);
    config = setEnabled(config, 'calendar', false);
    config = setEnabled(config, 'mail', false);
    writeConfig(config);
    markPhase('fda', true, 'unavailable');
    console.log('⏭ Apple data not present, skipping Apple plugins');
  } else {
    config = setEnabled(config, 'apple-notes', false);
    config = setEnabled(config, 'calendar', false);
    config = setEnabled(config, 'mail', false);
    writeConfig(config);
    markPhase('fda', false, 'denied');
    console.log('⚠ Full Disk Access denied. Apple plugins disabled.');
    console.log('  To enable: grant FDA, restart terminal, run `remembr setup`.');
  }

  const detected = detectInstalledClients();
  for (const client of detected) {
    installMcpFor(client);
    console.log(`✓ MCP installed for ${client.label}`);
  }
  markPhase('mcp', true, `installed:${detected.length}`);

  console.log('▸ Initial sync…');
  console.log('');
  await runSync({});
  markPhase('sync', true, 'ok');

  console.log('');
  console.log('✓ Setup complete.');

  if (claudeAvailable()) {
    const running = await isClaudeRunning().catch(() => false);
    if (running) {
      console.log('  Claude Code is running — restart it to load the new MCP server:');
      console.log('    osascript -e \'tell application "Claude" to quit\' && open -a Claude');
    } else {
      console.log('  Open Claude Code to start using remembr:');
      console.log('    open -a Claude');
    }
  } else {
    console.log('  Restart your MCP client to see remembr in the tools list.');
  }
}

function addPath(config: BrainConfig, plugin: string, path: string): BrainConfig {
  const slot = config.plugins[plugin] ?? { enabled: true };
  const existing = (slot.paths as string[] | undefined) ?? [];
  const next = existing.includes(path) ? existing : [...existing, path];
  return {
    ...config,
    plugins: {
      ...config.plugins,
      [plugin]: { ...slot, enabled: true, paths: next },
    },
  };
}

function setEnabled(config: BrainConfig, plugin: string, enabled: boolean): BrainConfig {
  const slot = config.plugins[plugin] ?? { enabled };
  return {
    ...config,
    plugins: {
      ...config.plugins,
      [plugin]: { ...slot, enabled },
    },
  };
}
