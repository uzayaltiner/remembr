import { describe, expect, it } from 'vitest';
import {
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  chunkMarkdown,
  parseMarkdown,
} from '../../src/plugins/fs/parser.js';

describe('parseMarkdown', () => {
  it('extracts frontmatter title when present', () => {
    const raw = `---
title: My Note
tags: [a, b]
---
# Different heading

Body.`;
    const parsed = parseMarkdown(raw);
    expect(parsed.title).toBe('My Note');
    expect(parsed.frontmatter['tags']).toEqual(['a', 'b']);
  });

  it('falls back to first H1 when frontmatter has no title', () => {
    const raw = `---
date: 2025-01-01
---
# Hello world

Body.`;
    const parsed = parseMarkdown(raw);
    expect(parsed.title).toBe('Hello world');
  });

  it('returns null title when no frontmatter and no H1', () => {
    const raw = 'Just some body text.';
    const parsed = parseMarkdown(raw);
    expect(parsed.title).toBeNull();
  });

  it('strips frontmatter from chunked body', () => {
    const raw = `---
title: T
---

# Heading

Body content.`;
    const parsed = parseMarkdown(raw);
    expect(parsed.chunks.join('\n')).not.toContain('title: T');
  });
});

describe('chunkMarkdown', () => {
  it('returns empty array for empty input', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n  ')).toEqual([]);
  });

  it('returns single chunk for short content', () => {
    const chunks = chunkMarkdown('Hello world.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Hello world.');
  });

  it('splits on heading boundaries when content is large enough', () => {
    const big = 'paragraph '.repeat(50); // ≈ 500 chars
    const raw = `# A

${big}

# B

${big}

# C

${big}`;
    const chunks = chunkMarkdown(raw);
    // Each section ≈ 500 chars, well below merge threshold so they should stay separate
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('splits oversized sections on paragraph boundaries', () => {
    const para = 'word '.repeat(200); // ≈ 1000 chars per paragraph
    const raw = `# Big

${para}

${para}

${para}

${para}`;
    const chunks = chunkMarkdown(raw);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
  });

  it('merges very small chunks with neighbours', () => {
    const raw = `# Tiny 1

a

# Tiny 2

b

# Tiny 3

c`;
    const chunks = chunkMarkdown(raw);
    // Each section is ~10 chars, well under MIN_CHUNK_CHARS — should collapse
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Tiny 1');
    expect(chunks[0]).toContain('Tiny 3');
  });

  it('hard-splits a single paragraph that exceeds MAX_CHUNK_CHARS', () => {
    const huge = 'x'.repeat(MAX_CHUNK_CHARS * 3);
    const chunks = chunkMarkdown(huge);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS + 100); // small tolerance
    }
  });

  it('produces non-empty trimmed chunks', () => {
    const raw = '# A\n\ncontent\n\n# B\n\nmore content here that is reasonably long';
    const chunks = chunkMarkdown(raw);
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
      expect(chunk).toBe(chunk.trim());
    }
  });

  it('respects min chunk threshold', () => {
    expect(MIN_CHUNK_CHARS).toBeLessThan(MAX_CHUNK_CHARS);
  });
});
