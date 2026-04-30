/**
 * Markdown parsing + chunking.
 *
 * Strategy:
 *  1. Strip and capture frontmatter via gray-matter.
 *  2. Split body on heading boundaries (lines starting with #).
 *  3. Sub-split oversized sections into paragraph groups.
 *  4. Merge undersized chunks into neighbours.
 *
 * Chunk size primitives live in `../_shared/chunker.ts` so the markdown,
 * text, and PDF chunkers stay byte-for-byte consistent.
 */

import matter from 'gray-matter';
import {
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  TARGET_CHUNK_CHARS,
  assembleParagraphs,
  mergeUndersized,
} from '../_shared/chunker.js';

export { MAX_CHUNK_CHARS, MIN_CHUNK_CHARS, TARGET_CHUNK_CHARS };

export interface ParsedMarkdown {
  /** Frontmatter title, first H1, or null. */
  title: string | null;
  /** All frontmatter fields (free-form). */
  frontmatter: Record<string, unknown>;
  /** Body chunks ready for embedding. */
  chunks: string[];
}

export function parseMarkdown(raw: string): ParsedMarkdown {
  const { content, data } = matter(raw);
  const frontmatter = data as Record<string, unknown>;

  const title = extractTitle(frontmatter, content);
  const chunks = chunkMarkdown(content);

  return { title, frontmatter, chunks };
}

function extractTitle(frontmatter: Record<string, unknown>, body: string): string | null {
  const fmTitle = frontmatter.title;
  if (typeof fmTitle === 'string' && fmTitle.trim().length > 0) {
    return fmTitle.trim();
  }

  const h1Match = /^\s*#\s+(.+?)\s*$/m.exec(body);
  if (h1Match?.[1]) return h1Match[1].trim();

  return null;
}

/** Split a markdown body into chunks roughly TARGET_CHUNK_CHARS long. */
export function chunkMarkdown(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];

  const opts = {
    min: MIN_CHUNK_CHARS,
    target: TARGET_CHUNK_CHARS,
    max: MAX_CHUNK_CHARS,
  };

  const sections = splitOnHeadings(trimmed);
  const chunks = sections.flatMap((s) =>
    s.length > MAX_CHUNK_CHARS ? assembleParagraphs(s, opts) : [s],
  );
  return mergeUndersized(chunks, MIN_CHUNK_CHARS);
}

/** Split a markdown body into top-level sections delimited by `#` lines. */
function splitOnHeadings(body: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of body.split('\n')) {
    if (/^\s*#{1,6}\s+/.test(line) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n'));

  return sections;
}
