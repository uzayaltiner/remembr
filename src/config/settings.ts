import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PATHS } from './paths.ts';

export interface OllamaConfig {
  host: string;
  model: string;
}

export interface EmbedderConfig {
  /** Provider id: 'ollama' (today), 'transformers', 'voyage', 'openai' (later). */
  provider: 'ollama' | 'transformers' | 'voyage' | 'openai';
  /** Provider-specific model id; falls back to ollama.model when provider==='ollama'. */
  model?: string;
}

export interface PluginConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface BrainConfig {
  version: string;
  ollama: OllamaConfig;
  embedder?: EmbedderConfig;
  plugins: Record<string, PluginConfig>;
}

export const DEFAULT_CONFIG: BrainConfig = {
  version: '0.1.0',
  ollama: {
    host: 'http://localhost:11434',
    model: 'nomic-embed-text',
  },
  embedder: {
    provider: 'transformers',
    model: 'Xenova/multilingual-e5-small',
  },
  plugins: {
    fs: { enabled: true },
    browser: { enabled: true, maxAgeDays: 180, minVisitCount: 1 },
    pdf: { enabled: true },
    calendar: { enabled: true },
    github: { enabled: true },
    slack: { enabled: true },
    mail: { enabled: true },
    'apple-notes': { enabled: true },
  },
};

/**
 * Ensure every registered plugin has a slot in the config so users can opt
 * out of new plugins after a remembr upgrade. Keeps existing values
 * (notably user-set `enabled: false`) untouched.
 *
 * Returns the (possibly upgraded) config + a flag telling the caller
 * whether anything changed, so we only rewrite the file when necessary.
 */
export function mergeRegisteredPlugins(
  config: BrainConfig,
  registeredNames: string[],
): { config: BrainConfig; changed: boolean } {
  let changed = false;
  const plugins = { ...config.plugins };
  for (const name of registeredNames) {
    if (!plugins[name]) {
      plugins[name] = { enabled: true };
      changed = true;
    }
  }
  return { config: changed ? { ...config, plugins } : config, changed };
}

/** Ensure ~/.remembr/ and subdirectories exist. Idempotent. */
export function ensureHome(): void {
  for (const dir of [PATHS.home, PATHS.logs, PATHS.plugins]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function configExists(): boolean {
  return existsSync(PATHS.config);
}

export function readConfig(): BrainConfig {
  if (!configExists()) {
    throw new Error(`Config not found at ${PATHS.config}. Run 'remembr init' first.`);
  }
  const raw = readFileSync(PATHS.config, 'utf-8');
  const parsed = JSON.parse(raw) as BrainConfig;
  return parsed;
}

export function writeConfig(config: BrainConfig): void {
  ensureHome();
  writeFileSync(PATHS.config, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}
