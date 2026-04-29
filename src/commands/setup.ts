/**
 * `remembr setup` — guided installation as a resumable state machine.
 *
 * Phases:
 *   1. bootstrap   ~/.remembr/ + default config
 *   2. paths       fs/pdf scan dirs
 *   3. fda         Full Disk Access — exits cleanly if denied
 *   4. mcp         register the MCP server with detected clients
 *   5. sync        run a foreground initial sync
 *
 * Each phase is idempotent and writes its result into
 * `~/.remembr/.setup-state.json`. A second run skips already-completed
 * phases. The most common reason for a re-run is FDA: macOS only applies
 * new TCC permissions to processes launched AFTER they're granted, so
 * the only correct UX is "exit, restart terminal, run setup again".
 *
 * `--reset` clears the state file and starts over.
 * `--yes` accepts every default (non-interactive).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  type BrainConfig,
  configExists,
  ensureHome,
  readConfig,
  writeConfig,
} from '../config/settings.js';
import { markPhase, readSetupState, resetSetupState } from '../config/setup-state.js';
import { type FdaStatus, checkFullDiskAccess, openFdaSystemSettings } from '../utils/fda.js';
import { runInit } from './init.js';
import { type McpClient, detectInstalledClients, installMcpFor } from './mcp-install.js';
import { runSync } from './sync-cmd.js';

const APPLE_PLUGINS = ['apple-notes', 'calendar', 'mail'] as const;

export interface SetupOptions {
  /** Skip every prompt and accept defaults. Useful for CI / scripted use. */
  yes?: boolean;
  /** Wipe the saved phase state before starting (run every phase from scratch). */
  reset?: boolean;
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  if (options.reset) {
    resetSetupState();
    console.log('ℹ Setup state cleared — running every phase from scratch.');
    console.log('');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = async (prompt: string): Promise<string> => {
    if (options.yes) return 'y';
    return (await rl.question(prompt)).trim();
  };

  const askYesNo = async (prompt: string, defaultYes = true): Promise<boolean> => {
    const ans = await ask(prompt);
    if (ans.length === 0) return defaultYes;
    return defaultYes ? !/^n(o)?$/i.test(ans) : /^y(es)?$/i.test(ans);
  };

  try {
    console.log('');
    console.log('Welcome to remembr.');
    console.log(
      'Local-first semantic search across your notes, browser, mail, calendar, and more.',
    );
    console.log('');

    let state = readSetupState();

    // ───────────────── 1. bootstrap ─────────────────
    if (!state.phases.bootstrap.completed || !configExists()) {
      ensureHome();
      runInit({ quiet: true });
      console.log('✓ Bootstrapped ~/.remembr/');
      state = markPhase('bootstrap', true);
    } else {
      console.log('✓ Already bootstrapped.');
    }
    console.log('');

    let config = readConfig();

    // ───────────────── 2. paths ─────────────────
    if (!state.phases.paths.completed) {
      const wantsDocs = await askYesNo(
        'Index files in ~/Documents (Markdown, text, code, PDFs)? [Y/n] ',
      );
      if (wantsDocs) {
        const documents = join(homedir(), 'Documents');
        config = addPath(config, 'fs', documents);
        config = addPath(config, 'pdf', documents);
        console.log(`  ✓ ${documents}`);

        if (!options.yes) {
          for (;;) {
            const answer = await ask('  Additional directory to index? (Enter to finish) ');
            if (answer.length === 0) break;
            const expanded = expandPath(answer);
            if (!existsSync(expanded)) {
              console.log(`    ⚠ Path does not exist: ${expanded}`);
              continue;
            }
            config = addPath(config, 'fs', expanded);
            config = addPath(config, 'pdf', expanded);
            console.log(`    ✓ ${expanded}`);
          }
        }
      } else {
        config = setEnabled(config, 'fs', false);
        config = setEnabled(config, 'pdf', false);
        console.log('  ⏭ fs and pdf plugins disabled.');
      }
      writeConfig(config);
      state = markPhase('paths', true, wantsDocs ? 'configured' : 'skipped');
    } else {
      console.log('✓ Paths already configured.');
    }
    console.log('');

    // ───────────────── 3. fda ─────────────────
    if (!state.phases.fda.completed) {
      const wantsApple = await askYesNo(
        'Index Apple Notes, Calendar, and Mail? (requires Full Disk Access) [Y/n] ',
      );

      if (!wantsApple) {
        for (const name of APPLE_PLUGINS) config = setEnabled(config, name, false);
        writeConfig(config);
        console.log('  ⏭ Apple plugins disabled.');
        state = markPhase('fda', true, 'declined');
      } else {
        const fda: FdaStatus = checkFullDiskAccess();
        if (fda === 'granted') {
          console.log('  ✓ Full Disk Access already granted.');
          state = markPhase('fda', true, 'granted');
        } else if (fda === 'unavailable') {
          for (const name of APPLE_PLUGINS) config = setEnabled(config, name, false);
          writeConfig(config);
          console.log('  ⏭ Apple databases not present on this machine.');
          state = markPhase('fda', true, 'unavailable');
        } else {
          // denied → exit cleanly. macOS only applies TCC to NEW processes,
          // so prompting in-place is broken by design.
          markPhase('fda', false, 'denied');
          rl.close();
          console.log('');
          console.log('✗ Full Disk Access is NOT granted to this terminal.');
          console.log('');
          console.log('Steps to grant it:');
          console.log('  1. System Settings → Privacy & Security → Full Disk Access');
          console.log('     (opening it now)');
          console.log('  2. Add your terminal app (Terminal / iTerm / Warp / Ghostty / …)');
          console.log('  3. Quit the terminal completely (Cmd+Q) and re-open it');
          console.log('     macOS only applies new TCC permissions to NEW processes.');
          console.log('  4. In the new terminal, run again:');
          console.log('       remembr setup');
          console.log('');
          console.log('  Setup will resume from where it left off.');
          try {
            await openFdaSystemSettings();
          } catch {
            console.log('  (Could not auto-open Settings — please open it manually.)');
          }
          process.exit(0);
        }
      }
    } else {
      console.log('✓ Full Disk Access phase already done.');
    }
    console.log('');

    // ───────────────── 4. mcp ─────────────────
    if (!state.phases.mcp.completed) {
      const detected = detectInstalledClients();
      if (detected.length === 0) {
        console.log('ℹ No MCP-aware clients detected (Claude Code, Cursor, Cline).');
        console.log('  Once installed, run: remembr mcp install');
        state = markPhase('mcp', true, 'no-clients');
      } else {
        console.log('Detected MCP clients:');
        const installFor: McpClient[] = [];
        for (const client of detected) {
          const yes = await askYesNo(`  Install remembr for ${client.label}? [Y/n] `);
          if (yes) installFor.push(client);
        }
        for (const client of installFor) {
          const result = installMcpFor(client);
          if (result.status === 'unchanged') {
            console.log(`  ✓ ${client.label}: already up to date`);
          } else if (result.status === 'skipped') {
            console.log(`  ⚠ ${client.label}: ${result.reason ?? 'skipped'}`);
          } else {
            console.log(`  ✓ ${client.label}: installed`);
          }
        }
        state = markPhase('mcp', true, `installed:${installFor.length}`);
      }
    } else {
      console.log('✓ MCP integration already done.');
    }
    console.log('');

    rl.close();

    // ───────────────── 5. sync ─────────────────
    if (!state.phases.sync.completed) {
      console.log('Running initial sync (foreground)…');
      console.log('');
      try {
        await runSync({});
        state = markPhase('sync', true, 'ok');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`⚠ Initial sync hit an error: ${message}`);
        console.log('  Re-run later with: remembr sync');
        markPhase('sync', false, 'error');
      }
    } else {
      console.log('✓ Initial sync already done.');
      console.log('  (To re-index manually, run: remembr sync)');
    }

    // ───────────────── done ─────────────────
    console.log('');
    console.log('✓ Setup complete.');
    console.log('');
    console.log('Try it:');
    console.log('  remembr "your query"');
    console.log('  remembr               (interactive TUI)');
    console.log('  remembr status        (health + sync state)');
    console.log('');
    console.log('Restart your MCP client(s) to see remembr in the tools list.');
  } finally {
    rl.close();
  }
}

// ──────────────────────────────────────────────────────────
// Helpers

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

function expandPath(p: string): string {
  let out = p;
  if (out.startsWith('~')) out = join(homedir(), out.slice(1));
  return isAbsolute(out) ? out : resolve(out);
}
