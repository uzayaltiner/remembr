/**
 * PDF source plugin.
 *
 * Walks one or more directories for .pdf files, extracts text with pdf-parse,
 * chunks the body, and yields one Document per chunk.
 *
 * Plugin config (config.plugins.pdf):
 *   {
 *     "enabled": boolean,
 *     "paths": string[]   // directories to scan, ~ is expanded
 *   }
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { globIterate } from 'glob';
import type { Document, IngestContext, Plugin } from '../types.js';
import { parsePdf } from './parser.js';

const NAME = 'pdf';
const GLOB_PATTERN = '**/*.pdf';

// Reuse the fs plugin ignore list — most users put PDFs and notes in the
// same `~/Documents` tree, so they hit the same noise (node_modules with
// vendored manuals, build artefacts, Pods directories, …).
const IGNORE_PATTERNS = [
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/node_modules/**',
  '**/bower_components/**',
  '**/vendor/**',
  '**/Pods/**',
  '**/.gradle/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.next/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.obsidian/**',
  '**/.trash/**',
  '**/DerivedData/**',
  '**/*.xcworkspace/**',
  '**/*.xcodeproj/**',
];

// PDFs over 50 MB are almost always scans (no extractable text after OCR
// is performed — pdf-parse just churns) or huge dumps (annual reports,
// scanned books). Skip rather than block sync for minutes per file.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Per-file parse budget. Malformed PDFs can wedge pdf-parse on a regex
// loop indefinitely; cap each file at one minute and move on.
const PARSE_TIMEOUT_MS = 60_000;

// 3-way concurrent parse. pdf-parse is CPU-bound JS work; running 3 in
// parallel lets us interleave the parses with embedding I/O. Higher than
// 3 starts blowing memory on big books.
const PARSE_CONCURRENCY = 3;

interface PdfPluginConfig {
  enabled: boolean;
  paths?: string[];
}

interface PdfIngestOverrides {
  paths?: string[];
}

export const pdfPlugin: Plugin = {
  name: NAME,
  version: '0.1.0',
  description: 'Indexes .pdf files (books, papers, documents).',

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    const config = ctx.config as PdfPluginConfig;
    const overrides = (ctx.config._overrides as PdfIngestOverrides | undefined) ?? {};

    const rawPaths = overrides.paths ?? config.paths ?? [];
    const paths = rawPaths.map(expandPath);

    if (paths.length === 0) {
      throw new Error(
        "No paths configured for the 'pdf' plugin.\n  Add one: remembr paths add pdf ~/Documents/Books",
      );
    }

    // Stream the glob output instead of buffering the full list — protects
    // against ridiculous trees with millions of paths under user-set roots.
    const MAX_FILES = 50_000;
    const allFiles: string[] = [];
    let truncated = false;
    outer: for (const dir of paths) {
      for await (const match of globIterate(GLOB_PATTERN, {
        cwd: dir,
        absolute: true,
        nodir: true,
        dot: false,
        ignore: IGNORE_PATTERNS,
      })) {
        allFiles.push(match);
        if (allFiles.length >= MAX_FILES) {
          truncated = true;
          break outer;
        }
      }
    }

    const total = allFiles.length;
    let current = 0;

    ctx.onProgress?.({ current, total, message: `Found ${total} PDF files` });
    if (truncated) {
      ctx.onProgress?.({
        current,
        total,
        message: `⚠ Truncated to ${MAX_FILES} PDFs; narrow the configured paths to index more.`,
      });
    }

    // 3-way concurrent parse. pdf-parse is CPU-bound; running 3 at once
    // overlaps each parse with the upstream readFile and the downstream
    // embed pipeline, cutting wall time roughly in half on a books folder.
    for (let i = 0; i < allFiles.length; i += PARSE_CONCURRENCY) {
      if (ctx.signal?.aborted) return;
      const batch = allFiles.slice(i, i + PARSE_CONCURRENCY);
      const results = await Promise.all(batch.map(parseOne));

      for (const result of results) {
        if (ctx.signal?.aborted) return;
        current++;

        if (result.kind === 'skip') {
          ctx.onProgress?.({
            current,
            total,
            message: `⚠ Skipped ${basename(result.filePath)}: ${result.reason}`,
          });
          continue;
        }
        if (result.kind === 'empty') {
          ctx.onProgress?.({
            current,
            total,
            message: `⚠ ${basename(result.filePath)}: no extractable text (scanned?)`,
          });
          continue;
        }

        const { filePath, parsed, mtimeMs, size } = result;
        const baseDir = paths.find((p) => filePath.startsWith(p)) ?? paths[0] ?? '';
        const relPath = relative(baseDir, filePath);
        const title = parsed.title ?? basename(filePath, '.pdf');
        const fingerprint = `${mtimeMs}-${size}`;

        for (let c = 0; c < parsed.chunks.length; c++) {
          yield {
            id: relPath,
            title,
            content: parsed.chunks[c] ?? '',
            timestamp: mtimeMs,
            fingerprint,
            metadata: {
              path: filePath,
              chunkIndex: c,
              totalChunks: parsed.chunks.length,
              author: parsed.author,
              pages: parsed.pages,
            },
          };
        }

        ctx.onProgress?.({
          current,
          total,
          message: `Indexed ${relPath} (${parsed.chunks.length} chunks, ${parsed.pages} pages)`,
        });
      }
    }
  },
};

type PdfParseResult = ReturnType<typeof parsePdf> extends Promise<infer R> ? R : never;

type ParseOneResult =
  | { kind: 'ok'; filePath: string; parsed: PdfParseResult; mtimeMs: number; size: number }
  | { kind: 'skip'; filePath: string; reason: string }
  | { kind: 'empty'; filePath: string };

async function parseOne(filePath: string): Promise<ParseOneResult> {
  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_BYTES) {
      return {
        kind: 'skip',
        filePath,
        reason: `${(stats.size / 1024 / 1024).toFixed(0)}MB > ${MAX_FILE_BYTES / 1024 / 1024}MB`,
      };
    }
    const buffer = await readFile(filePath);
    const parsed = await withTimeout(parsePdf(buffer), PARSE_TIMEOUT_MS);
    if (parsed.chunks.length === 0) return { kind: 'empty', filePath };
    return { kind: 'ok', filePath, parsed, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'skip', filePath, reason };
  }
}

/**
 * Race a promise against a timeout. The losing branch leaks until the
 * underlying work resolves, but we don't await it — fine for our use
 * case (one bad PDF per run, GC eventually reclaims).
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`pdf-parse timed out after ${ms}ms`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function expandPath(p: string): string {
  let expanded = p;
  if (expanded.startsWith('~')) {
    expanded = join(homedir(), expanded.slice(1));
  }
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}
