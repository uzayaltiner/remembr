/**
 * Embedder factory: read config, return the right provider.
 */

import type { BrainConfig } from '../../config/settings.ts';
import { OllamaEmbedder } from './ollama.ts';
import { TransformersEmbedder } from './transformers.ts';
import { type Embedder, EmbedderError } from './types.ts';

export type { Embedder, EmbedTask } from './types.ts';
export { EmbedderError } from './types.ts';

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

    case 'voyage':
    case 'openai':
      throw new EmbedderError(
        `Provider '${provider}' is on the roadmap but not yet implemented.\n  Available today: 'transformers' (default), 'ollama'.`,
      );

    default:
      throw new EmbedderError(
        `Unknown embedder provider: '${provider}'.\n  Available: 'transformers', 'ollama'.`,
      );
  }
}
