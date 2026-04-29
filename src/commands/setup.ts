/**
 * `remembr setup` — one-shot guided installation.
 *
 * Replaces the multi-step "init → paths add → grant FDA → sync → claude
 * mcp add" dance with a single command that asks 3-4 questions and does
 * the rest. Designed to be the first thing a fresh user runs after
 * `npm install -g remembr`.
 *
 * The flow:
 *   1. Initialize ~/.remembr/ (idempotent)
 *   2. Ask which directories to index for fs + pdf
 *   3. Ask whether to enable Apple Notes / Calendar / Mail (FDA)
 *      — and walk the user through granting FDA if needed
 *   4. Install the MCP server entry into detected MCP clients
 *   5. Run an initial sync
 *
 * Power users can still call init / paths / sync / mcp install separately.
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
import { type FdaStatus, checkFullDiskAccess, openFdaSystemSettings } from '../utils/fda.js';
import { runInit } from './init.js';
import { type McpClient, detectInstalledClients, installMcpFor } from './mcp-install.js';
import { runSync } from './sync-cmd.js';

const APPLE_PLUGINS = ['apple-notes', 'calendar', 'mail'] as const;

export interface SetupOptions {
  /** Skip every prompt and accept defaults. Useful for CI / scripted use. */
  yes?: boolean;
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('');
    console.log('Welcome to remembr.');
    console.log(
      'Local-first semantic search across your notes, browser, mail, calendar, and more.',
    );
    console.log('');

    // 1. Init.
    if (!configExists()) {
      ensureHome();
      runInit();
      console.log('');
    }

    let config = readConfig();

    // 2. Path-based plugins.
    const pathQuestion = options.yes
      ? 'y'
      : (
          await rl.question('Index files in ~/Documents (Markdown, text, code, PDFs)? [Y/n] ')
        ).trim();
    const indexDocs = pathQuestion.length === 0 || /^y(es)?$/i.test(pathQuestion);

    if (indexDocs) {
      const documents = join(homedir(), 'Documents');
      config = addPath(config, 'fs', documents);
      config = addPath(config, 'pdf', documents);
      console.log(`✓ ${documents}`);

      if (!options.yes) {
        // Allow chaining additional paths.
        for (;;) {
          const answer = (
            await rl.question('Additional directory to index? (Enter to finish) ')
          ).trim();
          if (answer.length === 0) break;
          const expanded = expandPath(answer);
          if (!existsSync(expanded)) {
            console.log(`  ⚠ Path does not exist: ${expanded}`);
            continue;
          }
          config = addPath(config, 'fs', expanded);
          config = addPath(config, 'pdf', expanded);
          console.log(`  ✓ ${expanded}`);
        }
      }
    } else {
      // Disable both path-based plugins so sync doesn't complain.
      config = setEnabled(config, 'fs', false);
      config = setEnabled(config, 'pdf', false);
    }

    // 3. Apple plugins (FDA-gated).
    const appleAnswer = options.yes
      ? 'y'
      : (
          await rl.question(
            'Index Apple Notes, Calendar, and Mail? (requires Full Disk Access) [Y/n] ',
          )
        ).trim();
    const useApple = appleAnswer.length === 0 || /^y(es)?$/i.test(appleAnswer);

    if (useApple) {
      let status: FdaStatus = checkFullDiskAccess();
      if (status === 'unavailable') {
        console.log('⚠ Apple Notes database not found. Skipping Apple plugins on this machine.');
        for (const name of APPLE_PLUGINS) config = setEnabled(config, name, false);
      } else if (status === 'denied') {
        console.log('');
        console.log('ℹ Full Disk Access is not granted to your terminal yet.');
        console.log('  remembr will open System Settings → Privacy & Security → Full Disk Access.');
        console.log('  Add your terminal app (Terminal, iTerm, Warp, Ghostty, …),');
        console.log('  then come back here and press Enter.');
        if (!options.yes) {
          await rl.question('Press Enter to open System Settings… ');
        }
        try {
          await openFdaSystemSettings();
        } catch {
          console.log('  (Could not auto-open Settings — open it manually.)');
        }
        if (!options.yes) {
          await rl.question('Press Enter once you have added the terminal and re-launched it… ');
        }
        status = checkFullDiskAccess();
        if (status !== 'granted') {
          console.log(
            '⚠ FDA still not granted. Skipping Apple plugins. Re-run `remembr setup` once FDA is on.',
          );
          for (const name of APPLE_PLUGINS) config = setEnabled(config, name, false);
        } else {
          console.log('✓ Full Disk Access granted.');
        }
      } else {
        console.log('✓ Full Disk Access already granted.');
      }
    } else {
      for (const name of APPLE_PLUGINS) config = setEnabled(config, name, false);
    }

    writeConfig(config);

    // 4. MCP install — detect, prompt per client.
    const detected = detectInstalledClients();
    if (detected.length === 0) {
      console.log('');
      console.log('ℹ No MCP-aware clients detected (Claude Code, Cursor, Cline).');
      console.log('  Once installed, run: remembr mcp install');
    } else {
      console.log('');
      console.log('Detected MCP clients:');
      const installFor: McpClient[] = [];
      for (const client of detected) {
        const ans = options.yes
          ? 'y'
          : (await rl.question(`  Install remembr for ${client.label}? [Y/n] `)).trim();
        if (ans.length === 0 || /^y(es)?$/i.test(ans)) {
          installFor.push(client);
        }
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
    }

    // 5. Initial sync.
    console.log('');
    console.log('Running initial sync…');
    console.log('');
    rl.close();
    await runSync({});

    // 6. Done.
    console.log('');
    console.log('✓ Setup complete.');
    console.log('');
    console.log('Try it:');
    console.log('  remembr "your query"');
    console.log('  remembr (interactive TUI)');
    if (detected.length > 0) {
      console.log('');
      console.log('Restart your MCP client(s) to see remembr in the tools list.');
    }
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
