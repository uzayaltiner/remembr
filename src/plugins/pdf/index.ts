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
import { glob } from 'glob';
import type { Document, IngestContext, Plugin } from '../types.ts';
import { parsePdf } from './parser.ts';

const NAME = 'pdf';
const GLOB_PATTERN = '**/*.pdf';

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

    const allFiles: string[] = [];
    for (const dir of paths) {
      const matches = await glob(GLOB_PATTERN, {
        cwd: dir,
        absolute: true,
        nodir: true,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });
      allFiles.push(...matches);
    }

    const total = allFiles.length;
    let current = 0;

    ctx.onProgress?.({ current, total, message: `Found ${total} PDF files` });

    for (const filePath of allFiles) {
      if (ctx.signal?.aborted) return;
      current++;

      try {
        const buffer = await readFile(filePath);
        const stats = await stat(filePath);
        const parsed = await parsePdf(buffer);

        if (parsed.chunks.length === 0) {
          ctx.onProgress?.({
            current,
            total,
            message: `⚠ ${basename(filePath)}: no extractable text (scanned?)`,
          });
          continue;
        }

        const baseDir = paths.find((p) => filePath.startsWith(p)) ?? paths[0] ?? '';
        const relPath = relative(baseDir, filePath);
        const title = parsed.title ?? basename(filePath, '.pdf');
        const fingerprint = `${stats.mtimeMs}-${stats.size}`;

        for (let i = 0; i < parsed.chunks.length; i++) {
          yield {
            id: relPath,
            title,
            content: parsed.chunks[i] ?? '',
            timestamp: stats.mtimeMs,
            fingerprint,
            metadata: {
              path: filePath,
              chunkIndex: i,
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.onProgress?.({
          current,
          total,
          message: `⚠ Skipped ${basename(filePath)}: ${message}`,
        });
      }
    }
  },
};

function expandPath(p: string): string {
  let expanded = p;
  if (expanded.startsWith('~')) {
    expanded = join(homedir(), expanded.slice(1));
  }
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}
