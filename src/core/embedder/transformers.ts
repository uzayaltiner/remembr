/**
 * Transformers.js-backed Embedder.
 *
 * Runs ONNX models locally via @huggingface/transformers. The model is
 * downloaded on first use and cached in ~/.cache/huggingface (default)
 * or wherever HF_HOME points. Subsequent calls are fast.
 *
 * Default model is `Xenova/multilingual-e5-small`:
 *   - 384 dims
 *   - 100+ languages (good Turkish support, unlike English-only bge-small)
 *   - ~118MB download
 *   - Asymmetric retrieval: needs `passage:` / `query:` prefixes
 *
 * Other Xenova multilingual options:
 *   - Xenova/multilingual-e5-base       (768 dims, ~280MB, better recall)
 *   - Xenova/paraphrase-multilingual-MiniLM-L12-v2 (384 dims, sentence-level)
 */

import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type FeatureExtractionPipeline,
  type ProgressCallback,
  pipeline,
} from '@huggingface/transformers';
import { type EmbedTask, type Embedder, EmbedderError } from './types.js';

/** Classifies a thrown error from `pipeline()` so we can decide retry strategy. */
function classifyPipelineError(err: unknown): 'network' | 'cache' | 'unknown' {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes('enotfound') ||
    msg.includes('econnreset') ||
    msg.includes('eai_again') ||
    msg.includes('etimedout') ||
    msg.includes('connect timeout')
  ) {
    return 'network';
  }
  if (
    msg.includes('protobuf') ||
    msg.includes('onnx') ||
    msg.includes('unexpected eof') ||
    msg.includes('checksum') ||
    msg.includes('failed to parse')
  ) {
    return 'cache';
  }
  return 'unknown';
}

/**
 * @huggingface/transformers caches models under
 * `${HF_HOME ?? TRANSFORMERS_CACHE ?? ~/.cache/huggingface}/hub/models--<org>--<name>`.
 * Returns the path or null if we can't infer it for the current model id.
 */
function resolveModelCacheDir(model: string): string | null {
  const root =
    process.env.TRANSFORMERS_CACHE ??
    process.env.HF_HOME ??
    join(homedir(), '.cache', 'huggingface');
  const slug = model.includes('/') ? `models--${model.replace(/\//g, '--')}` : `models--${model}`;
  return join(root, 'hub', slug);
}

/**
 * ONNX weight precision. Quantized variants are ~2-4× faster on Apple
 * silicon at a barely-measurable recall hit, so 'q8' is the default.
 *  - 'fp32' / 'fp16': float weights — slower, slightly higher recall.
 *  - 'q8' / 'int8'   : 8-bit quantized — fast, marginal quality loss.
 *  - 'q4'           : 4-bit — fastest but more aggressive on quality.
 */
type TransformersDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'q4';

interface TransformersEmbedderOptions {
  /** HF model id, e.g. 'Xenova/multilingual-e5-small'. */
  model: string;
  /** Weight precision; defaults to 'q8' for the speed/quality balance. */
  dtype?: TransformersDtype;
  /** Optional progress callback for the first-run download. */
  onProgress?: ProgressCallback;
}

/**
 * Models that require asymmetric retrieval prefixes. The E5 family is the
 * most common: 'query:' for queries, 'passage:' for documents.
 */
const E5_LIKE = /e5/i;

interface AsymmetricPrefix {
  document: string;
  query: string;
}

const NO_PREFIX: AsymmetricPrefix = { document: '', query: '' };
const E5_PREFIX: AsymmetricPrefix = { document: 'passage: ', query: 'query: ' };

function pickPrefix(model: string): AsymmetricPrefix {
  if (E5_LIKE.test(model)) return E5_PREFIX;
  return NO_PREFIX;
}

export class TransformersEmbedder implements Embedder {
  readonly provider = 'transformers';
  readonly model: string;
  private pipe: FeatureExtractionPipeline | null = null;
  private dims = 0;
  private readonly prefix: AsymmetricPrefix;
  private readonly onProgress?: ProgressCallback;
  private readonly dtype: TransformersDtype;

  constructor(options: TransformersEmbedderOptions) {
    this.model = options.model;
    this.prefix = pickPrefix(options.model);
    this.onProgress = options.onProgress;
    this.dtype = options.dtype ?? 'q8';
  }

  get dimensions(): number {
    if (this.dims === 0) {
      throw new EmbedderError('TransformersEmbedder.dimensions accessed before init()');
    }
    return this.dims;
  }

  async init(): Promise<void> {
    if (this.pipe) return;

    try {
      const pipe = await this.loadPipelineWithRecovery();
      this.pipe = pipe;

      // Probe dimensions with a tiny embedding
      const probeText = `${this.prefix.document}probe`;
      const output = await pipe(probeText, { pooling: 'mean', normalize: true });
      const arr = output.tolist() as number[][];
      const first = arr[0];
      if (!first) {
        throw new EmbedderError(`Transformers model '${this.model}' produced empty embedding.`);
      }
      this.dims = first.length;
    } catch (err) {
      if (err instanceof EmbedderError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new EmbedderError(
        `Failed to load Transformers model '${this.model}'.\n  ${message}`,
        false,
        { cause: err },
      );
    }
  }

  /**
   * Run `pipeline()` with one targeted retry for the two failure modes
   * we can actually do something about: a transient network blip during
   * the first download, or a corrupt file in the local HF cache from a
   * prior interrupted download.
   */
  private async loadPipelineWithRecovery(): Promise<FeatureExtractionPipeline> {
    const opts = {
      dtype: this.dtype,
      // 'auto' picks the best available backend (webgpu/wasm/cpu).
      // 40-60% faster on Apple silicon vs the default cpu wasm path.
      device: 'auto' as const,
      progress_callback: this.onProgress,
    };

    try {
      return (await pipeline('feature-extraction', this.model, opts)) as FeatureExtractionPipeline;
    } catch (err) {
      const kind = classifyPipelineError(err);

      if (kind === 'cache') {
        // Wipe the (likely partial) local cache and try once more — fresh
        // download usually clears it.
        const dir = resolveModelCacheDir(this.model);
        if (dir && existsSync(dir)) {
          try {
            rmSync(dir, { recursive: true, force: true });
            process.stderr.write(
              `! Detected corrupt model cache at ${dir}; cleared and retrying.\n`,
            );
          } catch {
            // ignore — we'll just fall through to the final throw
          }
        }
        return (await pipeline(
          'feature-extraction',
          this.model,
          opts,
        )) as FeatureExtractionPipeline;
      }

      if (kind === 'network') {
        const message = err instanceof Error ? err.message : String(err);
        throw new EmbedderError(
          `Could not download model '${this.model}'.\n  ${message}\n  Check your network and retry. The download is one-shot and resumable.`,
          true,
          { cause: err },
        );
      }

      throw err;
    }
  }

  async embed(text: string, task: EmbedTask): Promise<number[]> {
    const result = await this.embedBatch([text], task);
    const first = result[0];
    if (!first) throw new EmbedderError('Empty embedding response from Transformers.js');
    return first;
  }

  async embedBatch(texts: string[], task: EmbedTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.pipe) await this.init();
    if (!this.pipe) throw new EmbedderError('Transformers pipeline not initialized');

    const prefix = task === 'query' ? this.prefix.query : this.prefix.document;
    const inputs = prefix ? texts.map((t) => `${prefix}${t}`) : texts;

    const output = await this.pipe(inputs, { pooling: 'mean', normalize: true });
    const arr = output.tolist() as number[][];

    if (arr.length !== texts.length) {
      throw new EmbedderError(`Expected ${texts.length} embeddings, got ${arr.length}`);
    }
    return arr;
  }
}
