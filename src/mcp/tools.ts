/**
 * MCP tool definitions exposed by `remembr serve`.
 *
 * Each tool is a small async handler that:
 *   - validates input via Zod
 *   - runs against the same Store + Embedder used by the CLI
 *   - returns text content suitable for an LLM to read
 *
 * We deliberately keep tools READ-ONLY for now. Mutating tools (add memory,
 * delete document, etc.) are deferred until we have user-tested the search
 * loop with Claude Code.
 */

import { z } from 'zod';
import { PATHS } from '../config/paths.js';
import { readConfig } from '../config/settings.js';
import { type Embedder, createEmbedder } from '../core/embedder/index.js';
import { type SearchResult, Store } from '../core/store.js';

let cachedEmbedder: Embedder | null = null;
async function getEmbedder(): Promise<Embedder> {
  if (cachedEmbedder) return cachedEmbedder;
  const config = readConfig();
  const embedder = createEmbedder(config);
  await embedder.init();
  cachedEmbedder = embedder;
  return embedder;
}

// ──────────────────────────────────────────────────────────
// search

export const SearchInputSchema = z.object({
  query: z.string().min(1).describe('Free-form natural-language query.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results to return.'),
  source: z
    .string()
    .optional()
    .describe("Restrict to a single source plugin (e.g. 'fs', 'browser', 'pdf')."),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;

export interface SearchOutput {
  query: string;
  total: number;
  results: Array<{
    source: string;
    documentId: string;
    title: string;
    snippet: string;
    url: string | null;
    score: number;
    timestamp: number;
  }>;
}

export async function runSearchTool(input: SearchInput): Promise<SearchOutput> {
  const embedder = await getEmbedder();
  const queryVec = await embedder.embed(input.query, 'query');

  const store = new Store({ path: PATHS.database, dimensions: queryVec.length });
  try {
    const results = store.searchHybrid(queryVec, input.query, {
      limit: input.limit,
      source: input.source,
    });
    return {
      query: input.query,
      total: results.length,
      results: results.map(toApiResult),
    };
  } finally {
    store.close();
  }
}

function toApiResult(r: SearchResult): SearchOutput['results'][number] {
  return {
    source: r.source,
    documentId: r.documentId,
    title: r.title,
    snippet: snippet(r.content, 300),
    url: r.url ?? null,
    // RRF stores a negative score in the distance slot; flip it so higher = better.
    score: Math.round(-r.distance * 1000) / 1000,
    timestamp: r.timestamp,
  };
}

function snippet(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1)}…`;
}

// ──────────────────────────────────────────────────────────
// list_sources

export const ListSourcesInputSchema = z.object({}).describe('No parameters.');

export type ListSourcesInput = z.infer<typeof ListSourcesInputSchema>;

export interface ListSourcesOutput {
  sources: Array<{
    name: string;
    enabled: boolean;
    chunkCount: number;
  }>;
}

export async function runListSourcesTool(_input: ListSourcesInput): Promise<ListSourcesOutput> {
  const config = readConfig();
  const embedder = await getEmbedder();
  const store = new Store({ path: PATHS.database, dimensions: embedder.dimensions });
  try {
    const sources = Object.entries(config.plugins).map(([name, cfg]) => ({
      name,
      enabled: cfg.enabled,
      chunkCount: store.count(name),
    }));
    return { sources };
  } finally {
    store.close();
  }
}
