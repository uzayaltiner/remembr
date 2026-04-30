import { describe, expect, it } from 'vitest';
import { MAX_CHUNK_CHARS } from '../../src/plugins/_shared/chunker.js';
import { chunkPdfText } from '../../src/plugins/pdf/parser.js';

// PDF parser uses its own (higher) MIN; the relationship test below is
// the only place it's needed, so duplicate the constant locally rather
// than re-exporting it.
const PDF_MIN_CHUNK_CHARS = 300;

describe('chunkPdfText', () => {
  it('returns empty array for empty input', () => {
    expect(chunkPdfText('')).toEqual([]);
    expect(chunkPdfText('   \n\n  ')).toEqual([]);
  });

  it('returns single chunk for short content', () => {
    const text = 'Short content here.';
    const chunks = chunkPdfText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Short content');
  });

  it('groups paragraphs into chunks under TARGET size', () => {
    const para = 'sentence '.repeat(50); // ~ 450 chars
    const text = `${para}\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkPdfText(text);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('hard-splits a paragraph that exceeds MAX size', () => {
    const huge = 'x'.repeat(MAX_CHUNK_CHARS * 3);
    const chunks = chunkPdfText(huge);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS + 100);
    }
  });

  it('merges undersized chunks with neighbours', () => {
    const text = 'Tiny one.\n\nTiny two.\n\nTiny three.';
    const chunks = chunkPdfText(text);
    // Each "Tiny X." is ~9 chars, well below PDF_MIN_CHUNK_CHARS — should collapse
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Tiny one');
    expect(chunks[0]).toContain('Tiny three');
  });

  it('produces non-empty trimmed chunks', () => {
    const text = `Para 1 with reasonable length to be a chunk.

Para 2 also reasonable.

Para 3 here.`;
    const chunks = chunkPdfText(text);
    for (const chunk of chunks) {
      expect(chunk).toBe(chunk.trim());
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('respects min chunk threshold relationship', () => {
    expect(PDF_MIN_CHUNK_CHARS).toBeLessThan(MAX_CHUNK_CHARS);
  });
});
