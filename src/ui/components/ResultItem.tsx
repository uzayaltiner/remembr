import { Box, Text } from 'ink';
import React, { type FC } from 'react';
import type { SearchResult } from '../../core/store.ts';

const SOURCE_ICONS: Record<string, string> = {
  fs: '📄',
  markdown: '📄', // legacy
  browser: '🌐',
  pdf: '📕',
  slack: '💬',
};

export interface ResultItemProps {
  result: SearchResult;
  selected: boolean;
}

const MAX_DOC_ID = 60;
const SNIPPET_LEN = 110;

export const ResultItem: FC<ResultItemProps> = ({ result, selected }) => {
  const icon = SOURCE_ICONS[result.source] ?? '•';
  const docId = truncate(result.documentId, MAX_DOC_ID);
  const snippet = collapseWhitespace(result.content).slice(0, SNIPPET_LEN);
  const distance = result.distance.toFixed(3);

  return (
    <Box flexDirection="column" marginY={0}>
      <Box>
        <Text color={selected ? 'cyan' : undefined} bold={selected}>
          {selected ? '› ' : '  '}
          {icon} {docId}
        </Text>
        <Text dimColor> · {distance}</Text>
      </Box>
      <Box marginLeft={4}>
        <Text dimColor wrap="truncate">
          {snippet}
        </Text>
      </Box>
    </Box>
  );
};

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `…${text.slice(text.length - (maxLen - 1))}`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
