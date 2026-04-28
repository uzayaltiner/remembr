/**
 * `remembr paths add|remove|list <plugin> <dir...>` — manage scan directories
 * stored in config.plugins.<plugin>.paths.
 *
 * Once configured, plugins read directly from config and `remembr index <plugin>`
 * works without --path arguments.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { configExists, readConfig, writeConfig } from '../config/settings.js';
import { registry } from '../plugins/registry.js';

export function runPathsAdd(pluginName: string, paths: string[]): void {
  ensureInitialized();
  ensureKnownPlugin(pluginName);

  const config = readConfig();
  const slot = config.plugins[pluginName] ?? { enabled: false };
  const existing = (slot.paths as string[] | undefined) ?? [];
  const expanded = paths.map(expandPath);

  let added = 0;
  for (const p of expanded) {
    if (!existsSync(p)) {
      console.error(`✗ Path does not exist: ${p}`);
      continue;
    }
    if (existing.includes(p)) {
      console.log(`ℹ Already configured: ${p}`);
      continue;
    }
    existing.push(p);
    added++;
    console.log(`✓ Added: ${p}`);
  }

  if (added === 0) {
    return;
  }

  config.plugins[pluginName] = { ...slot, paths: existing };
  writeConfig(config);

  if (!slot.enabled) {
    console.log('');
    console.log(`ℹ Plugin '${pluginName}' is disabled — enabling now.`);
    config.plugins[pluginName].enabled = true;
    writeConfig(config);
  }
}

export function runPathsRemove(pluginName: string, paths: string[]): void {
  ensureInitialized();
  ensureKnownPlugin(pluginName);

  const config = readConfig();
  const slot = config.plugins[pluginName];
  if (!slot || !Array.isArray(slot.paths)) {
    console.log(`ℹ No paths configured for '${pluginName}'.`);
    return;
  }

  const expanded = new Set(paths.map(expandPath));
  const before = (slot.paths as string[]).length;
  const next = (slot.paths as string[]).filter((p) => !expanded.has(p));
  const removed = before - next.length;

  if (removed === 0) {
    console.log("ℹ Nothing matched. Run 'remembr paths list' to see configured paths.");
    return;
  }

  config.plugins[pluginName] = { ...slot, paths: next };
  writeConfig(config);
  console.log(`✓ Removed ${removed} path${removed === 1 ? '' : 's'}.`);
}

export function runPathsList(pluginName?: string): void {
  ensureInitialized();
  const config = readConfig();

  const targets = pluginName ? [pluginName] : Object.keys(config.plugins);
  if (pluginName) ensureKnownPlugin(pluginName);

  let any = false;
  for (const name of targets) {
    const slot = config.plugins[name];
    const paths = (slot?.paths as string[] | undefined) ?? [];
    if (paths.length === 0) continue;

    any = true;
    console.log(`${name}:`);
    for (const p of paths) {
      console.log(`  ${p}`);
    }
  }

  if (!any) {
    console.log('No paths configured.');
    console.log('  Add one: remembr paths add <plugin> <dir>');
    console.log('  Example: remembr paths add markdown ~/Documents/Notes');
  }
}

function ensureInitialized(): void {
  if (!configExists()) {
    console.error("✗ Not initialized. Run 'remembr init' first.");
    process.exit(1);
  }
}

function ensureKnownPlugin(name: string): void {
  if (!registry.has(name)) {
    console.error(`✗ Unknown plugin: '${name}'`);
    console.error("  Run 'remembr plugins list' to see available plugins.");
    process.exit(1);
  }
}

function expandPath(p: string): string {
  let out = p;
  if (out.startsWith('~')) out = join(homedir(), out.slice(1));
  return isAbsolute(out) ? out : resolve(out);
}
