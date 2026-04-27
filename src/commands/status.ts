import { PATHS } from '../config/paths.ts';
import { configExists, readConfig } from '../config/settings.ts';
import { EmbedderError, createEmbedder } from '../core/embedder/index.ts';

const CHECK = '✓';
const CROSS = '✗';
const INFO = 'ℹ';

export async function runStatus(): Promise<void> {
  // 1. Config
  if (!configExists()) {
    console.log(`${CROSS} Config:  not initialized`);
    console.log(`         Run 'remembr init' first.`);
    process.exit(1);
  }
  console.log(`${CHECK} Config:  ${PATHS.config}`);

  const config = readConfig();

  // 2. Embedder (provider + model + dimensions all in one)
  const embedder = createEmbedder(config);
  try {
    await embedder.init();
  } catch (err) {
    const message =
      err instanceof EmbedderError ? err.message : err instanceof Error ? err.message : String(err);
    console.log(`${CROSS} Embedder: ${embedder.provider} / ${embedder.model}`);
    for (const line of message.split('\n')) {
      console.log(`         ${line}`);
    }
    process.exit(1);
  }
  console.log(
    `${CHECK} Embedder: ${embedder.provider} / ${embedder.model} (${embedder.dimensions} dims)`,
  );

  // 3. Plugins
  const enabled = Object.entries(config.plugins)
    .filter(([, cfg]) => cfg.enabled)
    .map(([name]) => name);
  const available = Object.keys(config.plugins);

  if (enabled.length === 0) {
    console.log(`${INFO} Plugins:  0 enabled (available: ${available.join(', ')})`);
  } else {
    console.log(`${CHECK} Plugins:  ${enabled.length} enabled — ${enabled.join(', ')}`);
  }
}
