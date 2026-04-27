/**
 * Plugin contract.
 *
 * Plugins are the only place where data sources are read.
 * Core code (search, store, embedder) never knows about specific sources.
 *
 * To add a new source: implement Plugin, register it, that's it.
 */

import type { PluginConfig } from '../config/settings.ts';

export interface Document {
  /** Stable identifier on the plugin side (e.g. file path, URL, message id). */
  id: string;
  /** Plugin name (filled in by the registry — implementations leave undefined). */
  source?: string;
  title: string;
  content: string;
  url?: string;
  /** Unix epoch (ms). Use the most meaningful timestamp for the source. */
  timestamp: number;
  metadata?: Record<string, unknown>;
  /**
   * Document-level fingerprint for incremental indexing.
   * Same fingerprint = no change since last index, skip embedding.
   * Different = re-index. Empty/undefined = always re-index.
   *
   * Examples:
   *   markdown: `${mtimeMs}-${size}`
   *   pdf:      `${mtimeMs}-${size}`
   *   browser:  `v${visitCount}-${lastVisitTime}`
   *
   * All chunks of the same document MUST report the same fingerprint.
   */
  fingerprint?: string;
}

/** Context passed to a plugin during ingestion. */
export interface IngestContext {
  /** User-provided plugin config from ~/.remembr/config.json. */
  config: PluginConfig;
  /** Optional progress callback. */
  onProgress?: (event: ProgressEvent) => void;
  /** Optional cancellation. Plugins should check this between chunks. */
  signal?: AbortSignal;
}

export interface ProgressEvent {
  current: number;
  total?: number;
  message?: string;
}

export interface Plugin {
  /** Unique identifier — also the key in config.plugins. */
  readonly name: string;
  readonly version: string;
  readonly description: string;

  /**
   * Whether this plugin can run on the current system.
   * E.g. browser plugin checks for installed browsers.
   * Embedding plugins return true unconditionally.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Yield documents from this source.
   * Implementations should:
   *  • be resumable (tolerate partial runs)
   *  • respect ctx.signal between yields
   *  • emit progress events via ctx.onProgress when feasible
   */
  ingest(ctx: IngestContext): AsyncIterable<Document>;
}
