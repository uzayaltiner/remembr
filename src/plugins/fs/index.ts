/**
 * Filesystem source plugin.
 *
 * Reads text-like files (markdown, plain text) from one or more
 * directories. By default we index *notes only* — most users want
 * remembr to recall what they wrote, not their code lock files.
 * Source code is opt-in via the per-plugin `extensions` override
 * in `~/.remembr/config.json`.
 *
 * Plugin config (config.plugins.fs):
 *   {
 *     "enabled":    boolean,
 *     "paths":      string[],            // directories to scan
 *     "extensions": string[]             // optional override of file types
 *   }
 *
 * Default extensions: md, markdown, mdx, txt, rst, org
 *
 * To also index code, override extensions:
 *   remembr config show
 *   # then edit config.plugins.fs.extensions
 *
 * Code-friendly preset (suggested):
 *   ["md","markdown","mdx","txt","rst","org",
 *    "ts","tsx","js","jsx","py","go","rs","swift","java","kt"]
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { glob } from 'glob';
import type { Document, IngestContext, Plugin } from '../types.js';
import { parseMarkdown } from './parser.js';
import { chunkText } from './text-chunker.js';

const NAME = 'fs';

// Notes-first defaults. Indexing 4 000 .swift / .json / .yml files from a
// projects folder is almost never what the user wants.
const DEFAULT_EXTENSIONS = ['md', 'markdown', 'mdx', 'txt', 'rst', 'org'];

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const TEXT_LIKE_EXTS = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'org']);

// Per-file size guards. Notes-style files have a generous limit; everything
// else (typically source code, when explicitly enabled) has a tight one
// because giant generated artefacts blow up embedding time.
const MAX_TEXT_BYTES = 1_000_000; // 1 MB
const MAX_CODE_BYTES = 200_000; //  200 KB

// Directories and filename patterns we never want to index. Big surface
// because user-level ~/Documents folders often contain checked-out repos
// with build artefacts, lock files, and minified bundles.
const IGNORE_PATTERNS = [
  // VCS / editor / OS
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.DS_Store',
  '**/Thumbs.db',

  // package / dep dirs
  '**/node_modules/**',
  '**/bower_components/**',
  '**/vendor/**',
  '**/Pods/**',
  '**/.gradle/**',

  // Python / Ruby
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/env/**',
  '**/.pytest_cache/**',

  // build / cache
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.parcel-cache/**',
  '**/.eslintcache',
  '**/.tsbuildinfo',
  '**/coverage/**',
  '**/.nyc_output/**',

  // notes-app private dirs
  '**/.obsidian/**',
  '**/.trash/**',

  // iOS / Xcode generated
  '**/DerivedData/**',
  '**/*.xcworkspace/**',
  '**/*.xcodeproj/**',

  // lock & generated
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/Gemfile.lock',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/composer.lock',
  '**/*.lockb',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.bundle.js',
  '**/*.map',
  '**/*.log',
];

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
        ignore: IGNORE_PATTERNS,
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
        const ext = extname(filePath).slice(1).toLowerCase();
        const stats = await stat(filePath);

        // Tighter limit for code than for notes. Lock files and minified
        // bundles are already excluded via IGNORE_PATTERNS, but stray
        // generated artefacts still slip through occasionally.
        const sizeBudget = TEXT_LIKE_EXTS.has(ext) ? MAX_TEXT_BYTES : MAX_CODE_BYTES;
        if (stats.size > sizeBudget) {
          ctx.onProgress?.({
            current,
            total,
            message: `⚠ Skipped ${basename(filePath)} (${Math.round(stats.size / 1024)}KB > ${sizeBudget / 1024}KB)`,
          });
          continue;
        }

        const raw = await readFile(filePath, 'utf-8');
        if (raw.length === 0) continue;
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
