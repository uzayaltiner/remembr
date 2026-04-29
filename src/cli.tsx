#!/usr/bin/env node
import { Command } from 'commander';
import { runConfigModel, runConfigProvider, runConfigShow } from './commands/config-cmd.js';
import { runFda } from './commands/fda.js';
import { IndexError, runIndex, runWatch } from './commands/index-cmd.js';
import { runInit } from './commands/init.js';
import { type ClientName, runMcpInstall } from './commands/mcp-install.js';
import { runPathsAdd, runPathsList, runPathsRemove } from './commands/paths-cmd.js';
import { runPluginDisable, runPluginEnable, runPluginsList } from './commands/plugins.js';
import { runSearch } from './commands/search.js';
import { runServe } from './commands/serve.js';
import { runSetup } from './commands/setup.js';
import { runStatus } from './commands/status.js';
import { runSync } from './commands/sync-cmd.js';
import { bootstrapPlugins } from './plugins/index.js';
import { renderTUI } from './ui/render.js';

const VERSION = '0.1.0-pre.4';

bootstrapPlugins();

// Convenience: `remembr "<query>"` → `remembr search "<query>"`.
// If the first arg isn't a known subcommand, treat the whole tail as a search.
const KNOWN_COMMANDS = new Set([
  'init',
  'setup',
  'status',
  'index',
  'sync',
  'search',
  'serve',
  'plugins',
  'paths',
  'config',
  'mcp',
  'fda',
  'help',
  '--help',
  '-h',
  '--version',
  '-v',
]);

const firstArg = process.argv[2];

// `remembr` with no args → launch interactive TUI.
if (!firstArg) {
  await renderTUI();
  process.exit(0);
}

// `remembr "<query>"` → treat the unrecognised token as a search.
if (firstArg && !firstArg.startsWith('-') && !KNOWN_COMMANDS.has(firstArg)) {
  process.argv.splice(2, 0, 'search');
}

const program = new Command();

program
  .name('remembr')
  .description('Recall anything across your tools — semantic search MCP server + CLI')
  .version(VERSION, '-v, --version', 'output the current version');

program
  .command('setup')
  .description('Guided one-shot setup: paths, FDA, MCP install, initial sync')
  .option('-y, --yes', 'accept defaults for every prompt (non-interactive)')
  .option('--reset', 'wipe saved phase state and run every phase from scratch')
  .action(async (opts: { yes?: boolean; reset?: boolean }) => {
    await runSetup({ yes: opts.yes, reset: opts.reset });
  });

program
  .command('fda')
  .description('Check or repair Full Disk Access for Apple plugins (macOS)')
  .option('--open', 'open System Settings → Full Disk Access if access is missing')
  .action(async (opts: { open?: boolean }) => {
    await runFda({ open: opts.open });
  });

program
  .command('init')
  .description('Initialize ~/.remembr/ and create default config (low-level)')
  .option('-f, --force', 'reset existing config to defaults')
  .action((opts: { force?: boolean }) => {
    runInit({ force: opts.force });
  });

program
  .command('status')
  .description('Check config, Ollama, and embedding model availability')
  .action(async () => {
    await runStatus();
  });

program
  .command('index <plugin>')
  .description('Ingest documents from a plugin into the local store')
  .option('-p, --path <dir...>', 'override paths to scan (markdown plugin)')
  .option('-b, --browsers <name...>', 'restrict to specific browsers (browser plugin)')
  .option('--max-age-days <days>', 'only index visits newer than N days (browser plugin)', (v) =>
    Number.parseInt(v, 10),
  )
  .option('--reset', "delete this plugin's existing data before re-indexing")
  .option('-w, --watch', 'after initial index, watch paths and re-index on change')
  .action(
    async (
      pluginName: string,
      opts: {
        path?: string[];
        browsers?: string[];
        maxAgeDays?: number;
        reset?: boolean;
        watch?: boolean;
      },
    ) => {
      const indexOptions = {
        path: opts.path,
        browsers: opts.browsers,
        maxAgeDays: opts.maxAgeDays,
        reset: opts.reset,
      };
      try {
        if (opts.watch) {
          await runWatch(pluginName, indexOptions);
        } else {
          await runIndex(pluginName, indexOptions);
        }
      } catch (err) {
        if (err instanceof IndexError) {
          for (const line of err.message.split('\n')) {
            console.error(line.startsWith('✗') ? line : `✗ ${line}`);
          }
          process.exit(1);
        }
        throw err;
      }
    },
  );

program
  .command('serve')
  .description('Start the MCP server on stdio (for Claude Code, Cursor, Cline, …)')
  .action(async () => {
    await runServe();
  });

program
  .command('search <query>')
  .description('Semantic search across indexed documents')
  .option('-n, --limit <count>', 'maximum number of results (default 5)', (v) =>
    Number.parseInt(v, 10),
  )
  .option('-s, --source <plugin>', 'restrict to a single plugin')
  .option('--json', 'emit results as JSON')
  .action(async (query: string, opts: { limit?: number; source?: string; json?: boolean }) => {
    await runSearch(query, { limit: opts.limit, source: opts.source, json: opts.json });
  });

program
  .command('sync')
  .description('Index every enabled plugin (no per-plugin flags needed)')
  .option('-w, --watch', 'after initial sync, keep watching for changes')
  .action(async (opts: { watch?: boolean }) => {
    await runSync({ watch: opts.watch });
  });

const paths = program
  .command('paths')
  .description('Manage scan directories per plugin (auto-enables the plugin)');

paths
  .command('add <plugin> <dir...>')
  .description('Add one or more directories for a plugin to scan')
  .action((plugin: string, dirs: string[]) => {
    runPathsAdd(plugin, dirs);
  });

paths
  .command('remove <plugin> <dir...>')
  .description('Remove directories from a plugin')
  .action((plugin: string, dirs: string[]) => {
    runPathsRemove(plugin, dirs);
  });

paths
  .command('list [plugin]')
  .description('Show configured directories (all plugins by default)')
  .action((plugin?: string) => {
    runPathsList(plugin);
  });

const config = program.command('config').description('Inspect and update configuration');

config
  .command('show')
  .description('Print the current config as JSON')
  .action(() => {
    runConfigShow();
  });

config
  .command('model <name>')
  .description('Switch the embedding model (within the current provider)')
  .option('--reset', 'wipe the existing index (required when dimensions change)')
  .action((name: string, opts: { reset?: boolean }) => {
    runConfigModel(name, { reset: opts.reset });
  });

config
  .command('provider <name>')
  .description('Switch the embedding provider: transformers (default) | ollama | voyage | openai')
  .option('-m, --model <model>', 'pin a specific model for this provider')
  .option('--reset', 'wipe the existing index (recommended when changing providers)')
  .action((name: string, opts: { model?: string; reset?: boolean }) => {
    runConfigProvider(name, { model: opts.model, reset: opts.reset });
  });

const mcp = program.command('mcp').description('Manage MCP client integrations');

mcp
  .command('install')
  .description('Register the remembr MCP server with detected clients (Claude Code, Cursor, Cline)')
  .option('--client <name>', 'install for a single client (claude-code | cursor | cline)')
  .option('--all', 'install for every supported client (even if not detected)')
  .action((opts: { client?: ClientName; all?: boolean }) => {
    runMcpInstall({ client: opts.client, all: opts.all });
  });

const plugins = program.command('plugins').description('Manage data source plugins');

plugins
  .command('list')
  .description('List all registered plugins')
  .action(async () => {
    await runPluginsList();
  });

plugins
  .command('enable <name>')
  .description('Enable a plugin')
  .action((name: string) => {
    runPluginEnable(name);
  });

plugins
  .command('disable <name>')
  .description('Disable a plugin')
  .action((name: string) => {
    runPluginDisable(name);
  });

program.parseAsync();
