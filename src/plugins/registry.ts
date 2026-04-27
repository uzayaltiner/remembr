import type { BrainConfig, PluginConfig } from '../config/settings.ts';
import type { Plugin } from './types.ts';

export interface PluginStatus {
  plugin: Plugin;
  enabled: boolean;
  available: boolean;
}

/**
 * In-memory registry of plugins.
 *
 * Plugins register themselves at module load (or are explicitly added in tests).
 * The registry is a thin lookup layer — it does not read or write config.
 */
export class Registry {
  private readonly plugins = new Map<string, Plugin>();

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin '${plugin.name}' is already registered.`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  list(): Plugin[] {
    return Array.from(this.plugins.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** List all plugins with their config-driven enabled state and runtime availability. */
  async listWithStatus(config: BrainConfig): Promise<PluginStatus[]> {
    const plugins = this.list();
    return Promise.all(
      plugins.map(async (plugin) => ({
        plugin,
        enabled: config.plugins[plugin.name]?.enabled ?? false,
        available: await plugin.isAvailable(),
      })),
    );
  }
}

/** Module-level singleton shared by core code. */
export const registry = new Registry();

/** Read the config slot for a plugin, or return a sane default. */
export function getPluginConfig(config: BrainConfig, name: string): PluginConfig {
  return config.plugins[name] ?? { enabled: false };
}

/** Update the enabled flag for a plugin in a config object (immutably). */
export function setPluginEnabled(config: BrainConfig, name: string, enabled: boolean): BrainConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      [name]: {
        ...(config.plugins[name] ?? { enabled: false }),
        enabled,
      },
    },
  };
}
