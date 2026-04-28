/**
 * `remembr index <plugin>` — pipe documents from a plugin through the
 * configured embedder into the SQLite store.
 *
 * The pipeline:
 *   plugin.ingest() → batches of N → embedder.embedBatch() → Store.upsertChunk()
 */

import chokidar from 'chokidar';
import { PATHS } from '../config/paths.ts';
import { configExists, readConfig, writeConfig } from '../config/settings.ts';
import { EmbedderError, createEmbedder } from '../core/embedder/index.ts';
import { Store } from '../core/store.ts';
import { registry, setPluginEnabled } from '../plugins/registry.ts';
import type { Document } from '../plugins/types.ts';
import { log } from '../utils/logger.ts';
import { Progress } from '../utils/progress.ts';

// 32 is a sweet spot for Transformers.js on M-series: the model amortises
// fixed overhead (tokenize call, ONNX session entry) over more inputs,
// and the GPU/ANE can handle the larger batch in a single forward pass.
// Anything larger starts running out of memory on bigger models.
const BATCH_SIZE = 32;

export interface IndexOptions {
  /** Override: path(s) for plugins that take paths (e.g. markdown). */
  path?: string[];
  /** Override: browsers to read (for the browser plugin). */
  browsers?: string[];
  /** Override: max age in days (browser plugin). */
  maxAgeDays?: number;
  /** Wipe existing data for this plugin before indexing. */
  reset?: boolean;
}

export class IndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexError';
  }
}

export async function runIndex(pluginName: string, options: IndexOptions = {}): Promise<void> {
  if (!configExists()) {
    throw new IndexError("Not initialized. Run 'remembr init' first.");
  }

  const plugin = registry.get(pluginName);
  if (!plugin) {
    throw new IndexError(
      `Unknown plugin: '${pluginName}'\n  Run 'remembr plugins list' to see available plugins.`,
    );
  }

  let config = readConfig();
  const pluginConfig = config.plugins[pluginName] ?? { enabled: false };

  if (!pluginConfig.enabled) {
    // Auto-enable: if user explicitly asked to index, that implies enable.
    config = setPluginEnabled(config, pluginName, true);
    writeConfig(config);
    console.log(`ℹ Plugin '${pluginName}' was disabled — auto-enabled.`);
  }

  // Init embedder (provider chosen by config)
  const embedder = createEmbedder(config);
  try {
    await embedder.init();
  } catch (err) {
    if (err instanceof EmbedderError) {
      throw new IndexError(`Embedder error: ${err.message}`);
    }
    throw new IndexError(`Embedder error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const dims = embedder.dimensions;

  // Open store
  const store = new Store({ path: PATHS.database, dimensions: dims });

  if (options.reset) {
    const removed = store.deleteBySource(pluginName);
    console.log(`ℹ Reset: removed ${removed} existing chunks for '${pluginName}'`);
  }

  // Pass CLI overrides into the plugin via a private config slot
  const ingestConfig = {
    ...pluginConfig,
    _overrides: {
      paths: options.path,
      browsers: options.browsers,
      maxAgeDays: options.maxAgeDays,
    },
  };

  console.log(`▸ Indexing with plugin: ${pluginName}`);
  console.log(`  Embedder:             ${embedder.provider} / ${embedder.model} (${dims} dims)`);
  console.log(`  Database:             ${PATHS.database}`);
  console.log('');

  const startedAt = Date.now();
  let chunkCount = 0;
  let skippedDocuments = 0;
  let updatedDocuments = 0;
  let newDocuments = 0;

  let buffer: Document[] = [];

  // Track which document_ids the plugin yielded this run, so we can clean up
  // stale records (e.g. files deleted on disk) at the end.
  const seenDocumentIds = new Set<string>();

  // Cache: documentId → action. Decided once per document, applied to every chunk.
  type DocAction = 'skip' | 'new' | 'update';
  const docDecisions = new Map<string, DocAction>();

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const texts = buffer.map((d) => d.content);
    const vectors = await embedder.embedBatch(texts, 'document');

    for (let i = 0; i < buffer.length; i++) {
      const doc = buffer[i];
      const vec = vectors[i];
      if (!doc || !vec) continue;

      const meta = (doc.metadata ?? {}) as { chunkIndex?: number };
      const chunkIndex = typeof meta.chunkIndex === 'number' ? meta.chunkIndex : 0;

      store.upsertChunk(
        {
          source: pluginName,
          documentId: doc.id,
          chunkIndex,
          title: doc.title,
          content: doc.content,
          url: doc.url ?? null,
          timestamp: doc.timestamp,
          metadata: doc.metadata ?? {},
          fingerprint: doc.fingerprint ?? '',
        },
        vec,
      );
    }

    chunkCount += buffer.length;
    buffer = [];
  };

  const progress = new Progress();

  let pluginIterator: AsyncIterator<Document> | null = null;

  try {
    pluginIterator = plugin
      .ingest({
        config: ingestConfig,
        onProgress: ({ current, total, message }) => {
          if (!message) return;
          // Lines that start with ⚠ are warnings — print above the progress bar
          if (message.startsWith('⚠')) {
            progress.log(message);
          } else {
            progress.update(current, total, message);
          }
        },
      })
      [Symbol.asyncIterator]();

    while (true) {
      let next: IteratorResult<Document>;
      try {
        next = await pluginIterator.next();
      } catch (err) {
        progress.finish();
        const message = err instanceof Error ? err.message : String(err);
        log.error('plugin ingest failed', { plugin: pluginName, error: message });
        // Bubble the message up so callers (CLI handler / sync) decide what
        // to do — exit with a clean message, or skip and move on.
        throw new IndexError(message);
      }
      if (next.done) break;
      const doc = next.value;
      seenDocumentIds.add(doc.id);

      // Decide once per document whether to index or skip.
      let decision = docDecisions.get(doc.id);
      if (!decision) {
        decision = decideForDocument(store, pluginName, doc, options.reset === true);
        docDecisions.set(doc.id, decision);
        if (decision === 'skip') skippedDocuments++;
        else if (decision === 'update') updatedDocuments++;
        else newDocuments++;
      }

      if (decision === 'skip') continue;

      buffer.push(doc);
      if (buffer.length >= BATCH_SIZE) {
        await flush();
      }
    }
    await flush();
    progress.finish();
    console.log('');

    // Stale cleanup: documents that exist in the store but weren't yielded
    // by the plugin this run are gone (file deleted, history pruned, etc).
    // Skip cleanup if --reset was used (we already wiped the source above).
    let staleRemoved = 0;
    if (!options.reset) {
      const stored = store.listDocumentIds(pluginName);
      for (const docId of stored) {
        if (!seenDocumentIds.has(docId)) {
          store.deleteDocument(pluginName, docId);
          staleRemoved++;
        }
      }
      if (staleRemoved > 0) {
        console.log(`ℹ Removed ${staleRemoved} stale documents (no longer in source)`);
      }
    }
  } finally {
    store.close();
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `✓ Indexed ${chunkCount} chunks: ${newDocuments} new, ${updatedDocuments} updated, ${skippedDocuments} unchanged`,
  );
  console.log(`  Elapsed: ${formatDuration(elapsedMs)}`);

  log.info('index complete', {
    plugin: pluginName,
    chunks: chunkCount,
    new: newDocuments,
    updated: updatedDocuments,
    unchanged: skippedDocuments,
    elapsedMs,
  });
}

/**
 * Decide whether to (re-)index a document or leave it alone.
 *
 * Returns 'skip' when fingerprint matches an existing record.
 * Returns 'update' for re-indexing an existing doc (and wipes old chunks).
 * Returns 'new' for first-time indexing.
 */
function decideForDocument(
  store: Store,
  source: string,
  doc: Document,
  reset: boolean,
): 'skip' | 'new' | 'update' {
  // --reset already wiped the source above; everything is "new"
  if (reset) return 'new';

  const newFingerprint = doc.fingerprint ?? '';
  const oldFingerprint = store.getDocumentFingerprint(source, doc.id);

  // Plugin emitted no fingerprint → always re-index (force mode)
  if (newFingerprint === '') {
    if (oldFingerprint !== null) {
      store.deleteDocument(source, doc.id);
      return 'update';
    }
    return 'new';
  }

  // Same fingerprint → already up-to-date
  if (oldFingerprint === newFingerprint) return 'skip';

  // Different fingerprint → wipe old chunks before re-indexing
  if (oldFingerprint !== null) {
    store.deleteDocument(source, doc.id);
    return 'update';
  }
  return 'new';
}

/**
 * Run an initial index, then keep watching the configured paths for changes.
 *
 * Currently supported only for plugins that operate on directories (markdown,
 * pdf). Browser plugin doesn't fit the watch model — call `index browser`
 * on a schedule instead.
 *
 * Re-index runs are debounced (1s) so a flurry of saves doesn't trigger
 * back-to-back indexing.
 */
export async function runWatch(pluginName: string, options: IndexOptions = {}): Promise<void> {
  if (!options.path || options.path.length === 0) {
    console.error("✗ --watch requires --path (browser plugin doesn't support watch).");
    console.error('  Example: remembr index markdown --path ~/Notes --watch');
    process.exit(1);
  }

  // Initial full index
  await runIndex(pluginName, options);

  console.log('');
  console.log('▸ Watching for changes (Ctrl+C to stop):');
  for (const dir of options.path) {
    console.log(`    ${dir}`);
  }
  console.log('');

  const watcher = chokidar.watch(options.path, {
    ignoreInitial: true,
    ignored: /(^|[\/\\])\.git([\/\\]|$)|node_modules|\.obsidian/,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  let debounceTimer: NodeJS.Timeout | null = null;
  let running = false;

  const triggerReindex = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (running) return;
      running = true;
      try {
        console.log(`[${new Date().toLocaleTimeString()}] Detected changes, re-indexing...`);
        await runIndex(pluginName, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`✗ Re-index failed: ${message}`);
        log.error('watch re-index failed', { plugin: pluginName, error: message });
      } finally {
        running = false;
      }
    }, 1000);
  };

  watcher.on('add', triggerReindex);
  watcher.on('change', triggerReindex);
  watcher.on('unlink', triggerReindex);

  // Wait forever (until Ctrl+C). The watcher keeps the event loop alive.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      console.log('\n▸ Stopping watcher...');
      watcher.close().then(() => resolve());
    });
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}
