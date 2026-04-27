/**
 * Debounced semantic search hook for the TUI.
 *
 * Reuses a single embedder instance across queries (init is expensive,
 * subsequent calls are fast). The store is opened per-query so we don't
 * hold a WAL handle open between keystrokes.
 */

import { useEffect, useRef, useState } from 'react';
import { PATHS } from '../../config/paths.ts';
import { readConfig } from '../../config/settings.ts';
import { type Embedder, createEmbedder } from '../../core/embedder/index.ts';
import { type SearchResult, Store } from '../../core/store.ts';

const DEBOUNCE_MS = 250;

export interface UseSearchResult {
  results: SearchResult[];
  loading: boolean;
  error: string | null;
}

export function useSearch(query: string, limit = 10): UseSearchResult {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const embedderRef = useRef<Embedder | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        if (!embedderRef.current) {
          const config = readConfig();
          embedderRef.current = createEmbedder(config);
          await embedderRef.current.init();
          if (cancelled) return;
        }

        const queryVec = await embedderRef.current.embed(trimmed, 'query');
        if (cancelled) return;

        const store = new Store({ path: PATHS.database, dimensions: queryVec.length });
        try {
          if (store.count() === 0) {
            if (!cancelled) {
              setResults([]);
              setError('Index is empty. Run: remembr index <plugin>');
            }
            return;
          }
          const found = store.searchHybrid(queryVec, trimmed, { limit });
          if (!cancelled) {
            setResults(found);
            setError(null);
          }
        } finally {
          store.close();
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, limit]);

  return { results, loading, error };
}
