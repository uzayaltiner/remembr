/**
 * `remembr sync [--watch]` — index every enabled plugin in one go.
 *
 * Reads each plugin's enabled flag from config and runs them sequentially.
 * No --path or per-plugin flags here on purpose: paths must be configured
 * via `remembr paths add` so users don't have to keep typing them.
 */

import { configExists, readConfig } from '../config/settings.ts';
import { registry } from '../plugins/registry.ts';
import { runIndex, runWatch } from './index-cmd.ts';

export interface SyncOptions {
  watch?: boolean;
}

export async function runSync(options: SyncOptions = {}): Promise<void> {
  if (!configExists()) {
    console.error("✗ Not initialized. Run 'remembr init' first.");
    process.exit(1);
  }

  const config = readConfig();
  const enabledPlugins = Object.entries(config.plugins)
    .filter(([, cfg]) => cfg.enabled)
    .map(([name]) => name)
    .filter((name) => registry.has(name));

  if (enabledPlugins.length === 0) {
    console.log('No enabled plugins.');
    console.log('');
    console.log('Get started:');
    console.log('  remembr plugins enable browser              # browser history');
    console.log('  remembr paths add markdown ~/Documents/Notes  # auto-enables markdown');
    console.log('  remembr paths add pdf ~/Documents/Books       # auto-enables pdf');
    return;
  }

  if (options.watch) {
    // Watch only makes sense for path-based plugins. Index path-less ones first
    // (browser), then keep the path-based watch loop alive.
    const pathBased = enabledPlugins.filter((name) => Array.isArray(config.plugins[name]?.paths));
    const pathLess = enabledPlugins.filter((name) => !Array.isArray(config.plugins[name]?.paths));

    for (const name of pathLess) {
      console.log(`▸ ${name}`);
      await runIndex(name, {});
      console.log('');
    }

    if (pathBased.length === 0) {
      console.log(
        "ℹ No path-based plugins to watch. Use 'remembr sync' (without --watch) for browser-only setups.",
      );
      return;
    }

    if (pathBased.length === 1) {
      const name = pathBased[0];
      if (!name) return;
      console.log(`▸ Watching ${name}`);
      const slot = config.plugins[name];
      const paths = (slot?.paths as string[] | undefined) ?? [];
      await runWatch(name, { path: paths });
      return;
    }

    // Multiple path-based plugins + watch: do an initial sync of all, then
    // watch only the first one. Watching multiple roots concurrently is
    // possible but adds complexity we'll defer until we need it.
    for (const name of pathBased) {
      console.log(`▸ ${name}`);
      await runIndex(name, {});
      console.log('');
    }
    const first = pathBased[0];
    if (!first) return;
    console.log(`ℹ Watching '${first}' (multi-plugin watch coming later).`);
    const slot = config.plugins[first];
    const paths = (slot?.paths as string[] | undefined) ?? [];
    await runWatch(first, { path: paths });
    return;
  }

  for (const name of enabledPlugins) {
    console.log(`▸ ${name}`);
    await runIndex(name, {});
    console.log('');
  }

  console.log(
    `✓ Sync complete (${enabledPlugins.length} plugin${enabledPlugins.length === 1 ? '' : 's'})`,
  );
}
