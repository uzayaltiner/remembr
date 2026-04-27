/**
 * Ollama HTTP client for local embeddings.
 *
 * Uses the `/api/embed` endpoint (Ollama 0.3+) which supports batching.
 * Falls back to per-call usage when batch is not needed.
 *
 * No external dependencies — just fetch.
 */

export class OllamaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OllamaError';
  }
}

export class OllamaUnreachableError extends OllamaError {
  constructor(host: string, cause?: unknown) {
    super(
      `Ollama is not reachable at ${host}.\n  • Is Ollama running? Try: ollama serve\n  • Or install: https://ollama.com`,
      { cause },
    );
    this.name = 'OllamaUnreachableError';
  }
}

export class OllamaModelMissingError extends OllamaError {
  constructor(model: string) {
    super(`Model '${model}' is not pulled.\n  Pull it with: ollama pull ${model}`);
    this.name = 'OllamaModelMissingError';
  }
}

interface TagsResponse {
  models: Array<{ name: string; model: string }>;
}

interface EmbedResponse {
  model: string;
  embeddings: number[][];
}

export interface OllamaClientOptions {
  host: string;
  model: string;
  /** Per-request timeout in ms. Defaults to 60s. */
  timeoutMs?: number;
}

/**
 * Some retrieval-tuned embedding models expect a task prefix on every input.
 * `nomic-embed-text` is the prominent example: without these prefixes,
 * documents and queries land in subtly different subspaces and recall tanks.
 *
 * Models that don't recognise prefixes simply treat them as opaque tokens
 * — the cost is small, so we apply them whenever the model name matches.
 */
const ASYMMETRIC_PREFIX_MODELS = [/^nomic-embed-text/i];

function needsAsymmetricPrefix(model: string): boolean {
  return ASYMMETRIC_PREFIX_MODELS.some((re) => re.test(model));
}

export type EmbedTask = 'document' | 'query';

const TASK_PREFIX: Record<EmbedTask, string> = {
  document: 'search_document: ',
  query: 'search_query: ',
};

export class OllamaClient {
  private readonly host: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaClientOptions) {
    this.host = options.host.replace(/\/$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** Check whether Ollama is reachable and responding. */
  async isReachable(): Promise<boolean> {
    try {
      await this.request('/api/tags', { method: 'GET' });
      return true;
    } catch {
      return false;
    }
  }

  /** List models that are pulled and available. */
  async listModels(): Promise<string[]> {
    const data = (await this.request('/api/tags', { method: 'GET' })) as TagsResponse;
    return data.models.map((m) => m.name);
  }

  /** Check whether the configured model is available. */
  async hasModel(): Promise<boolean> {
    const models = await this.listModels();
    // Model names can include tags (e.g., 'nomic-embed-text:latest')
    return models.some((name) => name === this.model || name.startsWith(`${this.model}:`));
  }

  /**
   * Generate an embedding for a single piece of text.
   *
   * `task` selects between document and query prefixes for retrieval-tuned
   * models. Defaults to 'document' for backwards compatibility, but callers
   * should always pass the appropriate task explicitly — recall is much worse
   * if you embed a query as a document or vice versa.
   */
  async embed(text: string, task: EmbedTask = 'document'): Promise<number[]> {
    const result = await this.embedBatch([text], task);
    const first = result[0];
    if (!first) {
      throw new OllamaError('Empty embedding response from Ollama');
    }
    return first;
  }

  /** Generate embeddings for multiple texts in a single request. */
  async embedBatch(texts: string[], task: EmbedTask = 'document'): Promise<number[][]> {
    if (texts.length === 0) return [];

    const inputs = needsAsymmetricPrefix(this.model)
      ? texts.map((t) => `${TASK_PREFIX[task]}${t}`)
      : texts;

    const data = (await this.request('/api/embed', {
      method: 'POST',
      body: JSON.stringify({ model: this.model, input: inputs }),
    })) as EmbedResponse;

    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new OllamaError(
        `Expected ${texts.length} embeddings, got ${data.embeddings?.length ?? 0}`,
      );
    }

    return data.embeddings;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.host}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 404 && text.includes('model')) {
          throw new OllamaModelMissingError(this.model);
        }
        throw new OllamaError(`Ollama responded ${response.status}: ${text}`);
      }

      return await response.json();
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OllamaError(`Ollama request timed out after ${this.timeoutMs}ms`);
      }
      throw new OllamaUnreachableError(this.host, err);
    } finally {
      clearTimeout(timer);
    }
  }
}
