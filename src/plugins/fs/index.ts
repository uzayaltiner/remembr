/**
 * Filesystem source plugin.
 *
 * Reads text-like files (markdown, plain text, source code) from one or
 * more directories. Frontmatter is parsed for markdown; for everything else
 * the file is chunked as plain text.
 *
 * Plugin config (config.plugins.fs):
 *   {
 *     "enabled": boolean,
 *     "paths":      string[],            // directories to scan
 *     "extensions": string[]             // optional override of file types
 *   }
 *
 * Default extensions cover most engineering text:
 *   md, markdown, txt, ts, tsx, js, jsx, py, go, rs, swift, java, kt,
 *   c, h, cpp, hpp, cs, rb, php, sh, sql, json, yaml, yml, toml
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { glob } from 'glob';
import type { Document, IngestContext, Plugin } from '../types.js';
import { parseMarkdown } from './parser.js';
import { chunkText } from './text-chunker.js';

const NAME = 'fs';

const DEFAULT_EXTENSIONS = [
  'md',
  'markdown',
  'mdx',
  'txt',
  'rst',
  'org',
  // common code
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'swift',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'sql',
  // configs
  'json',
  'yaml',
  'yml',
  'toml',
];

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);

export interface FsPluginConfig {
  paths?: string[];
  extensions?: string[];
}

export interface FsIngestOverrides {
  paths?: string[];
}

export const fsPlugin: Plugin = {
  name: NAME,
  version: '0.1.0',
  description: 'Indexes text + code files (md, txt, ts, py, go, rs, swift, …).',

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    const config = ctx.config as FsPluginConfig & { enabled: boolean };
    const overrides = (ctx.config._overrides as FsIngestOverrides | undefined) ?? {};

    const rawPaths = overrides.paths ?? config.paths ?? [];
    const paths = rawPaths.map(expandPath);

    if (paths.length === 0) {
      throw new Error(
        "No paths configured for the 'fs' plugin.\n  Add one: remembr paths add fs ~/Documents/Notes",
      );
    }

    const exts =
      config.extensions && config.extensions.length > 0 ? config.extensions : DEFAULT_EXTENSIONS;
    const globPatterns = buildGlobs(exts);

    const allFiles: string[] = [];
    for (const dir of paths) {
      const matches = await glob(globPatterns, {
        cwd: dir,
        absolute: true,
        nodir: true,
        dot: false,
        ignore: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.obsidian/**',
          '**/dist/**',
          '**/build/**',
          '**/target/**',
          '**/__pycache__/**',
        ],
      });
      allFiles.push(...matches);
    }

    const total = allFiles.length;
    let current = 0;

    ctx.onProgress?.({ current, total, message: `Found ${total} files` });

    for (const filePath of allFiles) {
      if (ctx.signal?.aborted) return;
      current++;

      try {
        const raw = await readFile(filePath, 'utf-8');
        const stats = await stat(filePath);

        if (raw.length === 0) continue;
        // Skip very large files — usually binaries or generated artifacts.
        if (raw.length > 5_000_000) {
          ctx.onProgress?.({
            current,
            total,
            message: `⚠ Skipped ${basename(filePath)} (>5MB)`,
          });
          continue;
        }

        const ext = extname(filePath).slice(1).toLowerCase();
        const baseDir = paths.find((p) => filePath.startsWith(p)) ?? paths[0] ?? '';
        const relPath = relative(baseDir, filePath);
        const fingerprint = `${stats.mtimeMs}-${stats.size}`;

        const isMarkdown = MARKDOWN_EXTS.has(ext);
        const { title, frontmatter, chunks } = isMarkdown
          ? parseMarkdown(raw)
          : {
              title: null as string | null,
              frontmatter: {} as Record<string, unknown>,
              chunks: chunkText(raw),
            };

        if (chunks.length === 0) continue;

        const docTitle = title ?? basename(filePath, extname(filePath));

        for (let i = 0; i < chunks.length; i++) {
          yield {
            id: relPath,
            title: docTitle,
            content: chunks[i] ?? '',
            timestamp: stats.mtimeMs,
            fingerprint,
            metadata: {
              path: filePath,
              ext,
              chunkIndex: i,
              totalChunks: chunks.length,
              frontmatter,
            },
          };
        }

        ctx.onProgress?.({
          current,
          total,
          message: `Indexed ${relPath} (${chunks.length} chunks)`,
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

function buildGlobs(exts: string[]): string[] {
  return exts.map((ext) => `**/*.${ext.replace(/^\./, '')}`);
}

function expandPath(p: string): string {
  let expanded = p;
  if (expanded.startsWith('~')) {
    expanded = join(homedir(), expanded.slice(1));
  }
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}
