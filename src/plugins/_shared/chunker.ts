/**
 * Shared text-chunking primitives used by the markdown (fs), plain-text
 * (fs), and PDF parsers.
 *
 * Three small operations stitched together cover every plugin we ship:
 *
 *   1. `assembleParagraphs(text, opts)`  splits on blank lines and
 *      packs paragraphs greedily up to `opts.target` characters,
 *      never exceeding `opts.max`. A paragraph longer than `opts.max`
 *      is passed through `opts.hardSplit` (default: char-based).
 *
 *   2. `mergeUndersized(chunks, min)`    folds any chunk shorter than
 *      `min` characters into its neighbours so the index doesn't end
 *      up full of single-line noise.
 *
 *   3. `hardSplitChars` / `hardSplitLines` are the two fallback
 *      strategies for paragraphs that are themselves too long.
 *
 * No tokenizer — character count is a reasonable proxy for embedding
 * cost (~1 token per 3-4 chars in EN/TR) and avoids a dependency.
 */

export const MIN_CHUNK_CHARS = 200;
export const TARGET_CHUNK_CHARS = 1500;
export const MAX_CHUNK_CHARS = 2400;

export interface ChunkOpts {
  /** Below this size, a chunk is folded into its neighbour. */
  min: number;
  /** Greedy buffer flushes when filling another paragraph would cross this. */
  target: number;
  /** A single paragraph above this size triggers `hardSplit`. */
  max: number;
  /** Strategy for splitting an oversized paragraph. */
  hardSplit?: (text: string, target: number) => string[];
}

export function assembleParagraphs(text: string, opts: ChunkOpts): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const splitter = opts.hardSplit ?? hardSplitChars;

  const out: string[] = [];
  let buffer = '';
  for (const para of paragraphs) {
    if (para.length > opts.max) {
      if (buffer.length > 0) {
        out.push(buffer);
        buffer = '';
      }
      out.push(...splitter(para, opts.target));
      continue;
    }
    if (buffer.length === 0) {
      buffer = para;
    } else if (buffer.length + para.length + 2 <= opts.target) {
      buffer = `${buffer}\n\n${para}`;
    } else {
      out.push(buffer);
      buffer = para;
    }
  }
  if (buffer.length > 0) out.push(buffer);
  return out;
}

export function mergeUndersized(chunks: string[], min: number): string[] {
  if (chunks.length <= 1) return chunks.map((c) => c.trim()).filter((c) => c.length > 0);

  const out: string[] = [];
  let pending = '';
  for (const chunk of chunks) {
    if (pending.length === 0) {
      pending = chunk;
      continue;
    }
    if (pending.length < min) {
      pending = `${pending}\n\n${chunk}`;
    } else {
      out.push(pending);
      pending = chunk;
    }
  }
  if (pending.length > 0) {
    if (pending.length < min && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]}\n\n${pending}`;
    } else {
      out.push(pending);
    }
  }
  return out.map((c) => c.trim()).filter((c) => c.length > 0);
}

export function hardSplitChars(text: string, target: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += target) {
    out.push(text.slice(i, i + target));
  }
  return out;
}

export function hardSplitLines(text: string, target: number): string[] {
  const lines = text.split('\n');
  // Single giant line (minified file, log dump) — fall back to chars.
  if (lines.length === 1) return hardSplitChars(text, target);

  const out: string[] = [];
  let buffer = '';
  for (const line of lines) {
    if (buffer.length + line.length + 1 > target && buffer.length > 0) {
      out.push(buffer);
      buffer = line;
    } else {
      buffer = buffer.length === 0 ? line : `${buffer}\n${line}`;
    }
  }
  if (buffer.length > 0) out.push(buffer);
  return out;
}
