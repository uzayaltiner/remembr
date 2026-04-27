import { PATHS } from '../config/paths.ts';
import { DEFAULT_CONFIG, configExists, ensureHome, writeConfig } from '../config/settings.ts';

export interface InitOptions {
  force?: boolean;
}

export function runInit(options: InitOptions = {}): void {
  const alreadyInitialized = configExists();

  if (alreadyInitialized && !options.force) {
    console.log(`✓ Already initialized at ${PATHS.home}`);
    console.log(`  Run 'remembr init --force' to reset config.`);
    return;
  }

  ensureHome();
  writeConfig(DEFAULT_CONFIG);

  if (alreadyInitialized) {
    console.log(`✓ Reset config at ${PATHS.config}`);
  } else {
    console.log(`✓ Created ${PATHS.home}`);
    console.log(`✓ Created ${PATHS.config}`);
  }

  console.log('');
  console.log('Next steps:');
  console.log('  1. Make sure Ollama is running: https://ollama.com');
  console.log('  2. Pull the embedding model: ollama pull nomic-embed-text');
  console.log('  3. Verify everything: remembr status');
}
