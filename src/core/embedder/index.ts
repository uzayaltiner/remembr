/**
 * Embedder factory: read config, return the right provider.
 */

import type { BrainConfig } from '../../config/settings.js';
import { OllamaEmbedder } from './ollama.js';
import { TransformersEmbedder } from './transformers.js';
import { type Embedder, EmbedderError } from './types.js';

export type { Embedder, EmbedTask } from './types.js';
export { EmbedderError } from './types.js';

const DEFAULT_TRANSFORMERS_MODEL = 'Xenova/multilingual-e5-small';

export function createEmbedder(config: BrainConfig): Embedder {
  const provider = config.embedder?.provider ?? 'transformers';

  switch (provider) {
    case 'transformers':
      return new TransformersEmbedder({
        model: config.embedder?.model ?? DEFAULT_TRANSFORMERS_MODEL,
      });

    case 'ollama':
      return new OllamaEmbedder({
        host: config.ollama.host,
        model: config.embedder?.model ?? config.ollama.model,
      });

    default:
      throw new EmbedderError(
        `Unknown embedder provider: '${provider}'.\n  Available: 'transformers', 'ollama'.`,
      );
  }
}
