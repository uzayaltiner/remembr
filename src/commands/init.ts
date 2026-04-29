import { PATHS } from '../config/paths.js';
import { DEFAULT_CONFIG, configExists, ensureHome, writeConfig } from '../config/settings.js';

export interface InitOptions {
  force?: boolean;
  /** When true, suppress the trailing "Next steps" hint (used by `remembr setup`). */
  quiet?: boolean;
}

export function runInit(options: InitOptions = {}): void {
  const alreadyInitialized = configExists();

  if (alreadyInitialized && !options.force) {
    if (!options.quiet) {
      console.log(`✓ Already initialized at ${PATHS.home}`);
      console.log(`  Run 'remembr init --force' to reset config.`);
    }
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

  if (options.quiet) return;

  console.log('');
  console.log('Next steps:');
  console.log('  1. One-shot guided setup:  remembr setup');
  console.log('  2. Or, manually:           remembr sync');
  console.log('  3. Health check:           remembr status');
}
