/**
 * PDF text extraction + chunking.
 *
 * Uses `pdf-parse` to pull plain text out of a PDF, then chunks it on
 * paragraph boundaries (PDFs rarely have reliable heading markup).
 *
 * Chunk size primitives live in `../_shared/chunker.ts`. PDFs use a
 * higher `min` because they tend to produce a lot of single-line
 * footer / header / page-number garbage that would otherwise survive
 * the merge pass.
 *
 * Limitations:
 *  - Scanned PDFs without OCR yield no text. We surface this as an
 *    empty-document case rather than crashing.
 *  - Complex multi-column layouts can produce jumbled text — pdf-parse
 *    returns reading order as it sees it, which is sometimes wrong.
 */

import { PDFParse } from 'pdf-parse';
import {
  MAX_CHUNK_CHARS,
  TARGET_CHUNK_CHARS,
  assembleParagraphs,
  mergeUndersized,
} from '../_shared/chunker.js';

const PDF_MIN_CHUNK_CHARS = 300;

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
  const chunks = assembleParagraphs(text, {
    min: PDF_MIN_CHUNK_CHARS,
    target: TARGET_CHUNK_CHARS,
    max: MAX_CHUNK_CHARS,
  });
  return mergeUndersized(chunks, PDF_MIN_CHUNK_CHARS);
}
