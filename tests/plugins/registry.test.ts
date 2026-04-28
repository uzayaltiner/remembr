import { describe, expect, it } from 'vitest';
import { type BrainConfig, DEFAULT_CONFIG } from '../../src/config/settings.js';
import { Registry, getPluginConfig, setPluginEnabled } from '../../src/plugins/registry.js';
import type { Document, IngestContext, Plugin } from '../../src/plugins/types.js';

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    name: 'fake',
    version: '1.0.0',
    description: 'fake plugin',
    isAvailable: async () => true,
    async *ingest(_ctx: IngestContext): AsyncIterable<Document> {
      yield {
        id: 'fake-1',
        title: 'fake',
        content: 'fake',
        timestamp: 0,
      };
    },
    ...overrides,
  };
}

describe('Registry', () => {
  it('registers and retrieves plugins', () => {
    const registry = new Registry();
    const plugin = makePlugin();
    registry.register(plugin);

    expect(registry.get('fake')).toBe(plugin);
    expect(registry.has('fake')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('refuses duplicate registrations', () => {
    const registry = new Registry();
    registry.register(makePlugin({ name: 'a' }));
    expect(() => registry.register(makePlugin({ name: 'a' }))).toThrow(/already registered/);
  });

  it('lists plugins sorted by name', () => {
    const registry = new Registry();
    registry.register(makePlugin({ name: 'zebra' }));
    registry.register(makePlugin({ name: 'apple' }));
    registry.register(makePlugin({ name: 'mango' }));

    expect(registry.list().map((p) => p.name)).toEqual(['apple', 'mango', 'zebra']);
  });

  describe('listWithStatus', () => {
    it('reflects enabled state from config', async () => {
      const registry = new Registry();
      registry.register(makePlugin({ name: 'a' }));
      registry.register(makePlugin({ name: 'b' }));

      const config: BrainConfig = {
        ...DEFAULT_CONFIG,
        plugins: {
          a: { enabled: true },
          b: { enabled: false },
        },
      };

      const statuses = await registry.listWithStatus(config);
      expect(statuses.find((s) => s.plugin.name === 'a')?.enabled).toBe(true);
      expect(statuses.find((s) => s.plugin.name === 'b')?.enabled).toBe(false);
    });

    it('treats unconfigured plugins as disabled', async () => {
      const registry = new Registry();
      registry.register(makePlugin({ name: 'orphan' }));

      const statuses = await registry.listWithStatus(DEFAULT_CONFIG);
      expect(statuses[0]?.enabled).toBe(false);
    });

    it('captures availability from the plugin', async () => {
      const registry = new Registry();
      registry.register(makePlugin({ name: 'unavailable', isAvailable: async () => false }));
      registry.register(makePlugin({ name: 'available', isAvailable: async () => true }));

      const statuses = await registry.listWithStatus(DEFAULT_CONFIG);
      expect(statuses.find((s) => s.plugin.name === 'unavailable')?.available).toBe(false);
      expect(statuses.find((s) => s.plugin.name === 'available')?.available).toBe(true);
    });
  });
});

describe('config helpers', () => {
  it('getPluginConfig returns the slot or a disabled default', () => {
    const config: BrainConfig = {
      ...DEFAULT_CONFIG,
      plugins: { mark: { enabled: true } },
    };
    expect(getPluginConfig(config, 'mark')).toEqual({ enabled: true });
    expect(getPluginConfig(config, 'missing')).toEqual({ enabled: false });
  });

  it('setPluginEnabled returns a new config without mutating the original', () => {
    const config: BrainConfig = { ...DEFAULT_CONFIG, plugins: { x: { enabled: false } } };
    const updated = setPluginEnabled(config, 'x', true);

    expect(updated.plugins.x?.enabled).toBe(true);
    expect(config.plugins.x?.enabled).toBe(false); // original untouched
  });

  it('setPluginEnabled preserves other plugin keys', () => {
    const config: BrainConfig = {
      ...DEFAULT_CONFIG,
      plugins: {
        a: { enabled: true, customField: 'keep me' },
        b: { enabled: false },
      },
    };
    const updated = setPluginEnabled(config, 'a', false);
    expect(updated.plugins.a).toEqual({ enabled: false, customField: 'keep me' });
    expect(updated.plugins.b).toEqual({ enabled: false });
  });

  it('setPluginEnabled creates a slot for previously unknown plugins', () => {
    const config: BrainConfig = { ...DEFAULT_CONFIG, plugins: {} };
    const updated = setPluginEnabled(config, 'new', true);
    expect(updated.plugins.new).toEqual({ enabled: true });
  });
});
