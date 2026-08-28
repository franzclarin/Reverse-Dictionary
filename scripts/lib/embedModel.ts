/**
 * Load an arbitrary Transformers.js model for evaluation only.
 *
 * The production path is `lib/embedder.ts` and is imported unchanged — the
 * harness must never embed queries through a second code path, or every number
 * it produces is fiction. This module exists for exactly one thing the
 * production embedder cannot do: encode with a *different* model, so the
 * fine-tune can be compared against `all-MiniLM-L6-v2` (its own base).
 *
 * The pipeline settings below are copied deliberately from `lib/embedder.ts`
 * and must stay identical to it:
 *   - `{ quantized: false }`         load the full-precision ONNX weights
 *   - `{ pooling: "mean", normalize: true }`  reproduce the
 *     sentence-transformers Transformer -> mean Pooling -> Normalize pipeline
 *
 * If `lib/embedder.ts` ever changes those, change them here too.
 */
import { pipeline, env } from "@xenova/transformers";

/**
 * Point Transformers.js at the HF CDN for this module's models.
 *
 * `env` is a PROCESS-WIDE SINGLETON shared with `lib/embedder.ts`, which since
 * RD-11 pins the opposite settings (local-only, remote disabled) so the
 * production model is read from the bundle. Both used to set this at module
 * scope, and whichever module body evaluated last silently won — that broke
 * `npm run eval:prod` with "both local and remote models are disabled", because
 * this file's `allowLocalModels = false` landed on top of the production
 * module's `allowRemoteModels = false`.
 *
 * Configure immediately before use instead. Safe because the harness embeds
 * sequentially — one model at a time, awaited — so no two loads interleave.
 * If that ever changes, this needs a lock rather than a call-site assignment.
 */
function configureRemoteModelEnv(): void {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
}

/** The base model the fine-tune started from, per the model card. */
export const BASE_MODEL = "Xenova/all-MiniLM-L6-v2";

/** The fine-tune currently serving production. */
export const PRODUCTION_MODEL = "franzclarin/ReverseDictionary";

type Embedder = (
  text: string,
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

const cache = new Map<string, Promise<Embedder>>();

function getPipeline(modelId: string): Promise<Embedder> {
  let existing = cache.get(modelId);
  if (!existing) {
    configureRemoteModelEnv();
    existing = pipeline("feature-extraction", modelId, {
      quantized: false,
    }) as unknown as Promise<Embedder>;
    cache.set(modelId, existing);
    // Never leave a rejected promise cached: on a warm process every later
    // call would fail instantly with the same stale error.
    existing.catch(() => {
      if (cache.get(modelId) === existing) cache.delete(modelId);
    });
  }
  return existing;
}

export async function embedWith(modelId: string, text: string): Promise<number[]> {
  const pipe = await getPipeline(modelId);
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/** Encode many texts, reusing one loaded pipeline. `onProgress` reports counts. */
export async function embedBatch(
  modelId: string,
  texts: string[],
  onProgress?: (done: number, total: number) => void
): Promise<number[][]> {
  const pipe = await getPipeline(modelId);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const result = await pipe(texts[i], { pooling: "mean", normalize: true });
    out.push(Array.from(result.data));
    if (onProgress && (i + 1) % 250 === 0) onProgress(i + 1, texts.length);
  }
  onProgress?.(texts.length, texts.length);
  return out;
}
