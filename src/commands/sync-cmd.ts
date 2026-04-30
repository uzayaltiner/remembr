/**
 * `remembr sync [--watch]` — index every enabled plugin in one go.
 *
 * Default behaviour: every registered plugin is enabled out of the box, so
 * `remembr sync` immediately tries to ingest from all of them. Plugins that
 * can't run (no paths configured, TCC blocked, source app not installed,
 * etc.) are skipped with a clear message so the run as a whole still
 * succeeds. Disable the noisy ones with `remembr plugins disable <name>`.
 */

import {
  type BrainConfig,
  configExists,
  mergeRegisteredPlugins,
  readConfig,
  writeConfig,
} from '../config/settings.js';
import { registry } from '../plugins/registry.js';
import { LockBusyError, acquireWriteLock } from '../utils/lock.js';
import { type IndexEventListener, runIndex, runWatch } from './index-cmd.js';

// Plugin sync order: cheap, predictable plugins first so the user gets
// hits in search results within the first few seconds, even on a cold run.
// Mail and browser go last because their first run dominates wall time.
const SYNC_ORDER: readonly string[] = [
  'apple-notes',
  'github',
  'calendar',
  'fs',
  'pdf',
  'browser',
  'mail',
];

export interface SyncOptions {
  watch?: boolean;
  /**
   * When set, the function emits structured events through this listener
   * instead of (only) writing to stdout. Used by the Ink-based setup TUI
   * to draw its own progress UI.
   */
  onEvent?: IndexEventListener;
}

interface PluginOutcome {
  name: string;
  status: 'indexed' | 'skipped' | 'failed';
  reason?: string;
}

const PATH_BASED_PLUGINS = new Set(['fs', 'pdf']);

function orderRank(name: string): number {
  const idx = SYNC_ORDER.indexOf(name);
  return idx === -1 ? SYNC_ORDER.length : idx;
}

export async function runSync(options: SyncOptions = {}): Promise<void> {
  if (!configExists()) {
    console.error("✗ Not initialized. Run 'remembr init' first.");
    process.exit(1);
  }

  // Serialize against any concurrent `remembr sync` / `remembr index`.
  // The MCP server (`serve`) is read-only and intentionally not gated.
  let lock: { release: () => void };
  try {
    lock = acquireWriteLock();
  } catch (err) {
    if (err instanceof LockBusyError) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  try {
    // Auto-add slots for any newly-registered plugin so users see them
    // (and can disable them) on the next run.
    const registered = registry.list();
    let config = readConfig();
    const merge = mergeRegisteredPlugins(
      config,
      registered.map((p) => p.name),
    );
    if (merge.changed) {
      writeConfig(merge.config);
      config = merge.config;
    }

    const enabledPlugins = registered
      .filter((p) => config.plugins[p.name]?.enabled !== false)
      .sort((a, b) => orderRank(a.name) - orderRank(b.name));

    if (enabledPlugins.length === 0) {
      if (!options.onEvent) {
        console.log('No enabled plugins.');
        console.log('  Re-enable: remembr plugins enable <name>');
      }
      return;
    }

    if (options.watch) {
      return await runWatchSync(
        enabledPlugins.map((p) => p.name),
        config,
      );
    }

    const quiet = options.onEvent !== undefined;
    const outcomes: PluginOutcome[] = [];

    await runEnabledPlugins(enabledPlugins, options, outcomes);

    if (!quiet) printSummary(outcomes);
  } finally {
    lock.release();
  }
}

async function runEnabledPlugins(
  enabledPlugins: ReadonlyArray<{ name: string; isAvailable: () => Promise<boolean> }>,
  options: SyncOptions,
  outcomes: PluginOutcome[],
): Promise<void> {
  const quiet = options.onEvent !== undefined;

  for (const plugin of enabledPlugins) {
    if (!quiet) console.log(`▸ ${plugin.name}`);

    // Skip plugins that explicitly say they aren't usable on this system —
    // saves the user a confusing error mid-pipeline.
    let available = true;
    try {
      available = await plugin.isAvailable();
    } catch {
      available = false;
    }
    if (!available) {
      if (!quiet) {
        console.log('  ⏭ skipped: not available on this system');
        console.log('');
      }
      options.onEvent?.({
        kind: 'error',
        plugin: plugin.name,
        error: 'not available on this system',
      });
      outcomes.push({ name: plugin.name, status: 'skipped', reason: 'unavailable' });
      continue;
    }

    try {
      await runIndex(plugin.name, { onEvent: options.onEvent });
      outcomes.push({ name: plugin.name, status: 'indexed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = friendlyReason(message);
      if (!quiet) {
        for (const line of message.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const prefix = trimmed.startsWith('✗') || trimmed.startsWith('⚠') ? '  ' : '  ✗ ';
          console.log(`${prefix}${trimmed}`);
        }
      }
      outcomes.push({
        name: plugin.name,
        // "no paths" / "not authenticated" are user-config issues, not crashes.
        status: reason === 'config' ? 'skipped' : 'failed',
        reason,
      });
    }

    if (!quiet) console.log('');
  }
}

async function runWatchSync(enabledNames: string[], config: BrainConfig): Promise<void> {
  // Initial sync of everything, then attach the watcher to a path-based
  // plugin (only those make sense to watch live).
  const watchable = enabledNames.find((name) => {
    if (!PATH_BASED_PLUGINS.has(name)) return false;
    const paths = config.plugins[name]?.paths as string[] | undefined;
    return Array.isArray(paths) && paths.length > 0;
  });

  for (const name of enabledNames) {
    console.log(`▸ ${name}`);
    try {
      await runIndex(name, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  ⏭ ${message.split('\n')[0]}`);
    }
    console.log('');
  }

  if (!watchable) {
    console.log("ℹ No watchable plugin (need 'fs' or 'pdf' with paths).");
    return;
  }

  console.log(`▸ Watching ${watchable}`);
  const paths = (config.plugins[watchable]?.paths as string[] | undefined) ?? [];
  await runWatch(watchable, { path: paths });
}

function friendlyReason(message: string): string {
  if (/no paths configured/i.test(message)) return 'config';
  if (/not authenticated/i.test(message)) return 'config';
  if (/full disk access/i.test(message)) return 'tcc';
  if (/not found/i.test(message)) return 'unavailable';
  if (/schema mismatch/i.test(message)) return 'schema';
  return 'error';
}

function printSummary(outcomes: PluginOutcome[]): void {
  const indexed = outcomes.filter((o) => o.status === 'indexed').length;
  const skipped = outcomes.filter((o) => o.status === 'skipped').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;

  if (failed === 0 && skipped === 0) {
    console.log(`✓ Sync complete (${indexed} plugin${indexed === 1 ? '' : 's'})`);
    return;
  }

  console.log(`Sync complete: ${indexed} indexed, ${skipped} skipped, ${failed} failed.`);
  if (skipped > 0) {
    console.log("  Tip: 'remembr plugins disable <name>' silences plugins you don't use.");
  }
}
