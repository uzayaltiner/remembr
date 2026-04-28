import { readConfig, writeConfig } from '../config/settings.js';
import { registry, setPluginEnabled } from '../plugins/registry.js';

export async function runPluginsList(): Promise<void> {
  const config = readConfig();
  const statuses = await registry.listWithStatus(config);

  if (statuses.length === 0) {
    console.log('No plugins registered.');
    return;
  }

  // Pretty alignment — pad name column to longest name + 2
  const nameWidth = Math.max(...statuses.map((s) => s.plugin.name.length)) + 2;

  console.log(`${'NAME'.padEnd(nameWidth)}STATUS         AVAILABLE  DESCRIPTION`);
  console.log('─'.repeat(nameWidth + 50));

  for (const { plugin, enabled, available } of statuses) {
    const status = enabled ? '✓ enabled    ' : '○ disabled   ';
    const avail = available ? '✓ yes    ' : '✗ no     ';
    console.log(`${plugin.name.padEnd(nameWidth)}${status}  ${avail}  ${plugin.description}`);
  }
}

export function runPluginEnable(name: string): void {
  togglePlugin(name, true);
}

export function runPluginDisable(name: string): void {
  togglePlugin(name, false);
}

function togglePlugin(name: string, enabled: boolean): void {
  if (!registry.has(name)) {
    console.error(`✗ Unknown plugin: '${name}'`);
    console.error(`  Run 'remembr plugins list' to see available plugins.`);
    process.exit(1);
  }

  const config = readConfig();
  const wasEnabled = config.plugins[name]?.enabled ?? false;

  if (wasEnabled === enabled) {
    console.log(`ℹ Plugin '${name}' is already ${enabled ? 'enabled' : 'disabled'}.`);
    return;
  }

  const updated = setPluginEnabled(config, name, enabled);
  writeConfig(updated);

  console.log(`✓ Plugin '${name}' ${enabled ? 'enabled' : 'disabled'}.`);
}
