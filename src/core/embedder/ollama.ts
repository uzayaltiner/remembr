/**
 * Ollama-backed Embedder implementation.
 *
 * Wraps the existing OllamaClient (which knows about asymmetric retrieval
 * prefixes for nomic-style models) behind the Embedder contract.
 */

import { OllamaClient, OllamaUnreachableError } from '../ollama.js';
import { type EmbedTask, type Embedder, EmbedderError } from './types.js';

export interface OllamaEmbedderOptions {
  host: string;
  model: string;
  /** Per-request timeout in ms. Defaults to 60s. */
  timeoutMs?: number;
}

export class OllamaEmbedder implements Embedder {
  readonly provider = 'ollama';
  readonly model: string;
  private readonly client: OllamaClient;
  private dims = 0;
  private initialized = false;

  constructor(options: OllamaEmbedderOptions) {
    this.model = options.model;
    this.client = new OllamaClient({
      host: options.host,
      model: options.model,
      timeoutMs: options.timeoutMs,
    });
  }

  get dimensions(): number {
    if (!this.initialized) {
      throw new EmbedderError('OllamaEmbedder.dimensions accessed before init()');
    }
    return this.dims;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    if (!(await this.client.isReachable())) {
      throw new EmbedderError(
        `Ollama is not reachable. Start it with 'ollama serve' or install: https://ollama.com`,
        true,
      );
    }

    if (!(await this.client.hasModel())) {
      throw new EmbedderError(
        `Ollama model '${this.model}' is not pulled. Run: ollama pull ${this.model}`,
        true,
      );
    }

    try {
      const probe = await this.client.embed('probe', 'document');
      this.dims = probe.length;
      this.initialized = true;
    } catch (err) {
      if (err instanceof OllamaUnreachableError) {
        throw new EmbedderError(err.message, true, { cause: err });
      }
      throw err;
    }
  }

  async embed(text: string, task: EmbedTask): Promise<number[]> {
    if (!this.initialized) await this.init();
    return this.client.embed(text, task);
  }

  async embedBatch(texts: string[], task: EmbedTask): Promise<number[][]> {
    if (!this.initialized) await this.init();
    return this.client.embedBatch(texts, task);
  }
}
