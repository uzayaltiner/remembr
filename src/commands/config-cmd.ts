/**
 * `remembr config <subcommand>` — read or update ~/.remembr/config.json safely.
 *
 * Most users will only ever need `remembr config model <name>` to switch
 * embedding models. Switching models invalidates the existing index
 * (different vector dimensions / different embedding space), so we offer
 * to reset the database in the same step.
 */

import { rmSync } from 'node:fs';
import { PATHS } from '../config/paths.ts';
import { configExists, readConfig, writeConfig } from '../config/settings.ts';

export function runConfigShow(): void {
  if (!configExists()) {
    console.error("✗ Not initialized. Run 'remembr init' first.");
    process.exit(1);
  }
  const config = readConfig();
  console.log(JSON.stringify(config, null, 2));
}

export interface ConfigModelOptions {
  /** Wipe the index database (required when changing embedding dimensions). */
  reset?: boolean;
}

export function runConfigModel(model: string, options: ConfigModelOptions = {}): void {
  if (!configExists()) {
    console.error("✗ Not initialized. Run 'remembr init' first.");
    process.exit(1);
  }

  const config = readConfig();
  const previous = config.embedder?.model ?? config.ollama.model;

  if (previous === model) {
    console.log(`ℹ Model is already '${model}'. Nothing to do.`);
    return;
  }

  // Update both slots so legacy and new code paths agree.
  const updated = {
    ...config,
    ollama: { ...config.ollama, model },
    embedder: {
      provider: config.embedder?.provider ?? 'transformers',
      model,
    },
  };
  writeConfig(updated);
  console.log(`✓ Model: ${previous} → ${model}`);

  if (options.reset) {
    resetDatabase();
    console.log('');
    console.log("Next: remembr index <plugin>  (re-index with the new model's embeddings)");
    return;
  }

  console.log('');
  console.log('⚠ Existing index was built with the previous model.');
  console.log('  Embeddings from different models live in incompatible spaces');
  console.log('  AND may have different dimensions. You almost certainly want');
  console.log('  to reset the index:');
  console.log('');
  console.log(`    remembr config model ${model} --reset`);
  console.log('');
  console.log('  Or manually:  rm ~/.remembr/db.sqlite* && remembr index <plugin>');
}

export interface ConfigProviderOptions {
  /** Optional model override; otherwise the provider's default applies. */
  model?: string;
  /** Wipe the index database. */
  reset?: boolean;
}

const VALID_PROVIDERS = ['transformers', 'ollama', 'voyage', 'openai'] as const;
type ProviderName = (typeof VALID_PROVIDERS)[number];

const DEFAULT_PROVIDER_MODEL: Record<ProviderName, string> = {
  transformers: 'Xenova/multilingual-e5-small',
  ollama: 'nomic-embed-text',
  voyage: 'voyage-3',
  openai: 'text-embedding-3-small',
};

export function runConfigProvider(provider: string, options: ConfigProviderOptions = {}): void {
  if (!configExists()) {
    console.error("✗ Not initialized. Run 'remembr init' first.");
    process.exit(1);
  }
  if (!VALID_PROVIDERS.includes(provider as ProviderName)) {
    console.error(`✗ Unknown provider: '${provider}'`);
    console.error(`  Available: ${VALID_PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  const config = readConfig();
  const previousProvider = config.embedder?.provider ?? 'transformers';
  const previousModel = config.embedder?.model ?? config.ollama.model;

  const newModel = options.model ?? DEFAULT_PROVIDER_MODEL[provider as ProviderName];

  if (previousProvider === provider && previousModel === newModel) {
    if (options.reset) {
      console.log(`ℹ Provider already '${provider}' / '${newModel}'.`);
      resetDatabase();
      console.log('');
      console.log('Next: remembr index <plugin>  (re-index from scratch)');
      return;
    }
    console.log(`ℹ Provider already '${provider}' / '${newModel}'. Nothing to do.`);
    return;
  }

  const updated = {
    ...config,
    embedder: {
      provider: provider as ProviderName,
      model: newModel,
    },
    // Keep ollama.model in sync when provider is ollama, so older code paths see the right value.
    ollama: provider === 'ollama' ? { ...config.ollama, model: newModel } : config.ollama,
  };
  writeConfig(updated);

  console.log(`✓ Provider: ${previousProvider} → ${provider}`);
  console.log(`✓ Model:    ${previousModel} → ${newModel}`);

  if (options.reset) {
    resetDatabase();
    console.log('');
    console.log('Next: remembr index <plugin>  (re-index with the new provider/model)');
    return;
  }

  console.log('');
  console.log('⚠ Existing index was built with the previous provider/model.');
  console.log('  Different embedding spaces are not interchangeable.');
  console.log('  Re-run with --reset to wipe the index:');
  console.log('');
  console.log(`    remembr config provider ${provider} --reset`);
}

function resetDatabase(): void {
  let removed = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${PATHS.database}${suffix}`, { force: true });
      removed++;
    } catch {
      // ignore — file may not exist
    }
  }
  if (removed > 0) {
    console.log(`✓ Cleared index at ${PATHS.database}`);
  }
}
