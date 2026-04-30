/**
 * Plain text / source code chunker.
 *
 * For non-markdown files we don't have heading structure, so we chunk on
 * paragraph boundaries with a line-aware hardSplit fallback for runaway
 * lines (logs, minified files).
 *
 * Sizes match the markdown chunker so the index stays uniform.
 */

import {
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  TARGET_CHUNK_CHARS,
  assembleParagraphs,
  hardSplitLines,
  mergeUndersized,
} from '../_shared/chunker.js';

export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= MAX_CHUNK_CHARS) return [trimmed];

  const chunks = assembleParagraphs(text, {
    min: MIN_CHUNK_CHARS,
    target: TARGET_CHUNK_CHARS,
    max: MAX_CHUNK_CHARS,
    hardSplit: hardSplitLines,
  });
  return mergeUndersized(chunks, MIN_CHUNK_CHARS);
}
