import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  OllamaClient,
  OllamaError,
  OllamaModelMissingError,
  OllamaUnreachableError,
} from '../../src/core/ollama.ts';

const HOST = 'http://localhost:11434';
const MODEL = 'nomic-embed-text';

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OllamaClient', () => {
  let client: OllamaClient;

  beforeEach(() => {
    client = new OllamaClient({ host: HOST, model: MODEL });
  });

  afterEach(() => {
    restoreFetch();
  });

  describe('isReachable', () => {
    it('returns true when /api/tags responds 200', async () => {
      mockFetch(async () => jsonResponse({ models: [] }));
      expect(await client.isReachable()).toBe(true);
    });

    it('returns false when fetch throws', async () => {
      mockFetch(async () => {
        throw new Error('ECONNREFUSED');
      });
      expect(await client.isReachable()).toBe(false);
    });
  });

  describe('listModels', () => {
    it('returns model names from /api/tags', async () => {
      mockFetch(async () =>
        jsonResponse({
          models: [
            { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest' },
            { name: 'llama3:8b', model: 'llama3:8b' },
          ],
        }),
      );
      const models = await client.listModels();
      expect(models).toEqual(['nomic-embed-text:latest', 'llama3:8b']);
    });

    it('throws OllamaUnreachableError when network fails', async () => {
      mockFetch(async () => {
        throw new Error('network down');
      });
      await expect(client.listModels()).rejects.toBeInstanceOf(OllamaUnreachableError);
    });
  });

  describe('hasModel', () => {
    it('matches exact model name', async () => {
      mockFetch(async () =>
        jsonResponse({ models: [{ name: 'nomic-embed-text', model: 'nomic-embed-text' }] }),
      );
      expect(await client.hasModel()).toBe(true);
    });

    it('matches model with :tag suffix', async () => {
      mockFetch(async () =>
        jsonResponse({
          models: [{ name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest' }],
        }),
      );
      expect(await client.hasModel()).toBe(true);
    });

    it('returns false when model is missing', async () => {
      mockFetch(async () => jsonResponse({ models: [{ name: 'llama3', model: 'llama3' }] }));
      expect(await client.hasModel()).toBe(false);
    });
  });

  describe('embed', () => {
    it('returns a single embedding vector', async () => {
      mockFetch(async () =>
        jsonResponse({
          model: MODEL,
          embeddings: [[0.1, 0.2, 0.3]],
        }),
      );
      const vec = await client.embed('hello');
      expect(vec).toEqual([0.1, 0.2, 0.3]);
    });

    it('throws when response has empty embeddings', async () => {
      mockFetch(async () => jsonResponse({ model: MODEL, embeddings: [] }));
      await expect(client.embed('hello')).rejects.toBeInstanceOf(OllamaError);
    });
  });

  describe('embedBatch', () => {
    it('returns multiple vectors in order', async () => {
      mockFetch(async () =>
        jsonResponse({
          model: MODEL,
          embeddings: [
            [0.1, 0.2],
            [0.3, 0.4],
            [0.5, 0.6],
          ],
        }),
      );
      const vecs = await client.embedBatch(['a', 'b', 'c']);
      expect(vecs).toHaveLength(3);
      expect(vecs[1]).toEqual([0.3, 0.4]);
    });

    it('returns empty array for empty input without calling fetch', async () => {
      const fetchMock = mock(() => Promise.resolve(jsonResponse({ embeddings: [] })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const vecs = await client.embedBatch([]);
      expect(vecs).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws when count mismatches', async () => {
      mockFetch(async () =>
        jsonResponse({
          model: MODEL,
          embeddings: [[0.1, 0.2]],
        }),
      );
      await expect(client.embedBatch(['a', 'b'])).rejects.toBeInstanceOf(OllamaError);
    });

    it('throws OllamaModelMissingError on 404 with model error', async () => {
      mockFetch(async () => new Response('model "foo" not found', { status: 404 }));
      await expect(client.embedBatch(['a'])).rejects.toBeInstanceOf(OllamaModelMissingError);
    });
  });
});
