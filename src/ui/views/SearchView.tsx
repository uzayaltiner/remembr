import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React, { type FC, useEffect, useState } from 'react';
import type { SearchResult } from '../../core/store.js';
import { ResultItem } from '../components/ResultItem.js';
import { useSearch } from '../hooks/useSearch.js';

const RESULT_LIMIT = 8;

export interface SearchViewProps {
  /** Called with the chosen result (or null if user quit). */
  onChoose: (result: SearchResult | null) => void;
}

export const SearchView: FC<SearchViewProps> = ({ onChoose }) => {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const { results, loading, error } = useSearch(query, RESULT_LIMIT);
  const { exit } = useApp();

  // Clamp selection when results shrink
  useEffect(() => {
    if (selected >= results.length) {
      setSelected(Math.max(0, results.length - 1));
    }
  }, [results.length, selected]);

  useInput((_input, key) => {
    if (key.escape) {
      onChoose(null);
      exit();
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.min(Math.max(0, results.length - 1), i + 1));
      return;
    }
    if (key.return) {
      const chosen = results[selected];
      if (chosen) {
        onChoose(chosen);
        exit();
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text color="magenta" bold>
          remembr
        </Text>
      </Box>

      <Box borderStyle="round" paddingX={1} marginTop={1}>
        <Text color="cyan">› </Text>
        <TextInput
          value={query}
          onChange={setQuery}
          placeholder="Search across your indexed sources..."
        />
      </Box>

      <Box marginTop={1} flexDirection="column">
        {loading && (
          <Text color="yellow" dimColor>
            Searching…
          </Text>
        )}
        {error && <Text color="red">✗ {error}</Text>}
        {!loading && !error && query.trim() && results.length === 0 && (
          <Text dimColor>No results for "{query}"</Text>
        )}
        {!loading && !error && !query.trim() && (
          <Text dimColor>Start typing to search across your indexed sources.</Text>
        )}

        {results.map((r, i) => (
          <ResultItem key={`${r.source}-${r.id}`} result={r} selected={i === selected} />
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate · enter select · esc quit</Text>
      </Box>
    </Box>
  );
};
