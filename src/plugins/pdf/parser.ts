/**
 * PDF text extraction + chunking.
 *
 * Uses `pdf-parse` to pull plain text out of a PDF, then chunks it on
 * paragraph boundaries (PDFs rarely have reliable heading markup).
 *
 * Limitations:
 *  - Scanned PDFs without OCR yield no text. We surface this as an
 *    empty-document case rather than crashing.
 *  - Complex multi-column layouts can produce jumbled text — pdf-parse
 *    returns reading order as it sees it, which is sometimes wrong.
 */

import { PDFParse } from 'pdf-parse';

export const MIN_CHUNK_CHARS = 300;
export const TARGET_CHUNK_CHARS = 1500;
export const MAX_CHUNK_CHARS = 2400;

export interface ParsedPdf {
  /** Title from PDF info dict, or null. */
  title: string | null;
  /** Author from PDF info dict, or null. */
  author: string | null;
  /** Number of pages. */
  pages: number;
  /** Body chunks ready for embedding. */
  chunks: string[];
  /** Raw extracted text length in characters. Useful for skipping scanned PDFs. */
  rawTextLength: number;
}

export async function parsePdf(buffer: Buffer): Promise<ParsedPdf> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const [info, text] = await Promise.all([parser.getInfo(), parser.getText()]);

    const infoMap = (info.info ?? {}) as Record<string, unknown>;
    const title = stringOrNull(infoMap.Title);
    const author = stringOrNull(infoMap.Author);

    const cleaned = cleanText(text.text ?? '');
    const chunks = chunkPdfText(cleaned);

    return {
      title,
      author,
      pages: info.total ?? text.pages?.length ?? 0,
      chunks,
      rawTextLength: cleaned.length,
    };
  } finally {
    await parser.destroy();
  }
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * Normalise PDF-extracted text:
 *  - Replace soft hyphenation artefacts ("hyphen-\nation" → "hyphenation")
 *  - Collapse runs of whitespace within a line
 *  - Keep blank lines (paragraph signal)
 */
function cleanText(raw: string): string {
  return raw
    .replace(/­/g, '') // soft hyphens
    .replace(/(\w+)-\n(\w+)/g, '$1$2') // line-break hyphenation
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkPdfText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.length > 0);

  const chunks: string[] = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (para.length > MAX_CHUNK_CHARS) {
      if (buffer.length > 0) {
        chunks.push(buffer);
        buffer = '';
      }
      chunks.push(...hardSplit(para));
      continue;
    }

    if (buffer.length === 0) {
      buffer = para;
    } else if (buffer.length + para.length + 2 <= TARGET_CHUNK_CHARS) {
      buffer = `${buffer}\n\n${para}`;
    } else {
      chunks.push(buffer);
      buffer = para;
    }
  }

  if (buffer.length > 0) chunks.push(buffer);

  return mergeUndersized(chunks);
}

function hardSplit(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += TARGET_CHUNK_CHARS) {
    out.push(text.slice(i, i + TARGET_CHUNK_CHARS));
  }
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
