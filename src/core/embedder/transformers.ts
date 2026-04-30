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

import {
  type FeatureExtractionPipeline,
  type ProgressCallback,
  pipeline,
} from '@huggingface/transformers';
import { type EmbedTask, type Embedder, EmbedderError } from './types.js';

/**
 * ONNX weight precision. Quantized variants are ~2-4× faster on Apple
 * silicon at a barely-measurable recall hit, so 'q8' is the default.
 *  - 'fp32' / 'fp16': float weights — slower, slightly higher recall.
 *  - 'q8' / 'int8'   : 8-bit quantized — fast, marginal quality loss.
 *  - 'q4'           : 4-bit — fastest but more aggressive on quality.
 */
export type TransformersDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'q4';

export interface TransformersEmbedderOptions {
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
      this.pipe = (await pipeline('feature-extraction', this.model, {
        // q8 quantization typically gives 2-4× speedup on Apple silicon
        // at <1% recall delta for retrieval-style use.
        dtype: this.dtype,
        // 'auto' picks the best available backend (webgpu/wasm/cpu).
        // 40-60% faster on Apple silicon vs the default cpu wasm path.
        device: 'auto',
        progress_callback: this.onProgress,
      })) as FeatureExtractionPipeline;

      // Probe dimensions with a tiny embedding
      const probeText = `${this.prefix.document}probe`;
      const output = await this.pipe(probeText, { pooling: 'mean', normalize: true });
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
