/**
 * `remembr search "<query>"` — semantic search over the indexed corpus.
 *
 * Pipeline:
 *   query → embedder.embed() → Store.search() → format and print.
 */

import { PATHS } from '../config/paths.js';
import { configExists, readConfig } from '../config/settings.js';
import { createEmbedder } from '../core/embedder/index.js';
import { type SearchResult, Store } from '../core/store.js';

const SOURCE_ICONS: Record<string, string> = {
  fs: '📄',
  browser: '🌐',
  pdf: '📕',
  calendar: '📅',
  github: '🐙',
  mail: '✉️',
  'apple-notes': '📝',
};

export interface SearchCommandOptions {
  limit?: number;
  source?: string;
  json?: boolean;
}

export async function runSearch(query: string, options: SearchCommandOptions = {}): Promise<void> {
  if (!query.trim()) {
    throw new Error('Empty query.');
  }

  if (!configExists()) {
    throw new Error("Not initialized. Run 'remembr init' first.");
  }

  const config = readConfig();
  const embedder = createEmbedder(config);
  try {
    await embedder.init();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message);
  }

  // Embed the query — use 'query' task prefix so retrieval-tuned models
  // place it in the same subspace as documents indexed earlier.
  const queryVec = await embedder.embed(query, 'query');
  const dims = queryVec.length;

  const store = new Store({ path: PATHS.database, dimensions: dims });
  let results: SearchResult[];

  try {
    if (store.count() === 0) {
      throw new Error('Index is empty. Run: remembr sync');
    }

    results = store.searchHybrid(queryVec, query, {
      limit: options.limit ?? 5,
      source: options.source,
    });
  } finally {
    store.close();
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  printResults(query, results);
}

function printResults(query: string, results: SearchResult[]): void {
  if (results.length === 0) {
    console.log(`No results for "${query}".`);
    return;
  }

  console.log('');
  for (const r of results) {
    const icon = SOURCE_ICONS[r.source] ?? '•';
    const chunkSuffix = describesMultipleChunks(r) ? ` (chunk ${r.chunkIndex})` : '';
    const distance = r.distance.toFixed(3);

    const head = `${icon} ${r.documentId}${chunkSuffix}`.padEnd(60);
    console.log(`${head}dist ${distance}`);
    console.log(`   ${dim(r.title)}`);
    console.log(`   ${snippet(r.content, 220)}`);
    console.log('');
  }
}

function describesMultipleChunks(r: SearchResult): boolean {
  const meta = r.metadata as { totalChunks?: number };
  return typeof meta.totalChunks === 'number' && meta.totalChunks > 1;
}

function snippet(content: string, maxLen: number): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1)}…`;
}

// ANSI dim (gracefully degrades on terminals without color)
function dim(text: string): string {
  if (process.stdout.isTTY) return `\x1b[2m${text}\x1b[0m`;
  return text;
}
