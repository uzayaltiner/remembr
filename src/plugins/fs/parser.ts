/**
 * Markdown parsing + chunking.
 *
 * Strategy:
 *  1. Strip and capture frontmatter via gray-matter.
 *  2. Split body on heading boundaries (lines starting with #).
 *  3. Sub-split oversized sections into paragraph groups.
 *  4. Merge undersized chunks into neighbours.
 *
 * No tokenizer — we approximate by character count (≈ 1 token per 3-4 chars
 * for English/Turkish). Good enough for embedding chunks.
 */

import matter from 'gray-matter';

export const MIN_CHUNK_CHARS = 200;
export const TARGET_CHUNK_CHARS = 1500;
export const MAX_CHUNK_CHARS = 2400;

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

  const sections = splitOnHeadings(trimmed);
  const oversized = sections.flatMap(splitOversized);
  const merged = mergeUndersized(oversized);

  return merged.map((c) => c.trim()).filter((c) => c.length > 0);
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

/** If a section is too large, split it on blank lines (paragraphs). */
function splitOversized(section: string): string[] {
  if (section.length <= MAX_CHUNK_CHARS) return [section];

  const paragraphs = section.split(/\n\s*\n/);
  const out: string[] = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 <= TARGET_CHUNK_CHARS) {
      buffer = buffer.length === 0 ? para : `${buffer}\n\n${para}`;
    } else {
      if (buffer.length > 0) out.push(buffer);
      buffer = para;
    }
  }
  if (buffer.length > 0) out.push(buffer);

  // Last-resort hard split if a paragraph itself is huge
  return out.flatMap((chunk) => (chunk.length > MAX_CHUNK_CHARS ? hardSplit(chunk) : [chunk]));
}

function hardSplit(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += TARGET_CHUNK_CHARS) {
    out.push(text.slice(i, i + TARGET_CHUNK_CHARS));
  }
  return out;
}

/** Merge tiny chunks into the next neighbour to avoid noise. */
function mergeUndersized(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;

  const out: string[] = [];
  let pending = '';

  for (const chunk of chunks) {
    if (pending.length === 0) {
      pending = chunk;
      continue;
    }
    if (pending.length < MIN_CHUNK_CHARS) {
      pending = `${pending}\n\n${chunk}`;
    } else {
      out.push(pending);
      pending = chunk;
    }
  }

  if (pending.length > 0) {
    if (pending.length < MIN_CHUNK_CHARS && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]}\n\n${pending}`;
    } else {
      out.push(pending);
    }
  }

  return out;
}
