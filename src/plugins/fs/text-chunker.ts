/**
 * Plain text / source code chunker.
 *
 * For non-markdown files we don't have heading structure, so we chunk on:
 *  - blank lines (paragraphs)
 *  - failing that, line groups
 *  - hard split for runaway lines (logs, minified files)
 *
 * Same target sizes as the markdown chunker so the index is uniform.
 */

const MIN_CHUNK_CHARS = 200;
const TARGET_CHUNK_CHARS = 1500;
const MAX_CHUNK_CHARS = 2400;

export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= MAX_CHUNK_CHARS) return [trimmed];

  const blocks = trimmed.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  const out: string[] = [];
  let buffer = '';

  for (const block of blocks) {
    if (block.length > MAX_CHUNK_CHARS) {
      if (buffer.length > 0) {
        out.push(buffer);
        buffer = '';
      }
      out.push(...hardSplit(block));
      continue;
    }

    if (buffer.length === 0) {
      buffer = block;
    } else if (buffer.length + block.length + 2 <= TARGET_CHUNK_CHARS) {
      buffer = `${buffer}\n\n${block}`;
    } else {
      out.push(buffer);
      buffer = block;
    }
  }

  if (buffer.length > 0) out.push(buffer);

  return mergeUndersized(out);
}

function hardSplit(text: string): string[] {
  const lines = text.split('\n');
  // If the block is one giant line (minified file), fall back to character split
  if (lines.length === 1) {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += TARGET_CHUNK_CHARS) {
      out.push(text.slice(i, i + TARGET_CHUNK_CHARS));
    }
    return out;
  }

  const out: string[] = [];
  let buffer = '';
  for (const line of lines) {
    if (buffer.length + line.length + 1 > TARGET_CHUNK_CHARS && buffer.length > 0) {
      out.push(buffer);
      buffer = line;
    } else {
      buffer = buffer.length === 0 ? line : `${buffer}\n${line}`;
    }
  }
  if (buffer.length > 0) out.push(buffer);
  return out;
}

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

  return out.map((c) => c.trim()).filter((c) => c.length > 0);
}
