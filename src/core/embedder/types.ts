/**
 * Embedder abstraction.
 *
 * remembr supports multiple embedding backends:
 *   - transformers (default): bundled, offline, multilingual
 *   - ollama:                power user, GPU-accelerated, more models
 *   - voyage / openai:        opt-in API for higher quality
 *
 * All implementations satisfy this interface so the rest of the system
 * (index, search, MCP server) doesn't care which one is active.
 */

export type EmbedTask = 'document' | 'query';

export interface Embedder {
  /** Display name of the provider, e.g. "transformers", "ollama". */
  readonly provider: string;
  /** Human-readable model identifier, e.g. "Xenova/multilingual-e5-small". */
  readonly model: string;

  /**
   * Resolve the model + verify availability. Must be called before embed().
   * Idempotent — repeat calls are no-ops.
   */
  init(): Promise<void>;

  /**
   * Number of components in each embedding vector. Available after init().
   * Throws if called before init() resolves.
   */
  readonly dimensions: number;

  /** Embed a single string. */
  embed(text: string, task: EmbedTask): Promise<number[]>;

  /** Embed a batch in one round-trip when supported, fallback to sequential. */
  embedBatch(texts: string[], task: EmbedTask): Promise<number[][]>;
}

export class EmbedderError extends Error {
  constructor(
    message: string,
    public readonly recoverable: boolean = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmbedderError';
  }
}
