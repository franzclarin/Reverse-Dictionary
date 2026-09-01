// Loads some *other* model, for comparison experiments only. The real model is
// always used through `lib/embedder.ts` unchanged, since a second way of
// measuring the live path would make every number fiction.
//
// The settings below are copied from `lib/embedder.ts` and must stay identical
// to it. If they change there, change them here too.
import { pipeline, env } from "@xenova/transformers";

/** Allow downloading models, which this file needs and the live app forbids. */
// These settings are global, so set them right before use, never at the top of
// a file: whichever file loads last would silently win and break the other.
// Safe only because models are loaded one at a time here.
function configureRemoteModelEnv(): void {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
}

/** The off-the-shelf model ours was built from. */
export const BASE_MODEL = "Xenova/all-MiniLM-L6-v2";

/** The model the live site uses. */
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
    // Forget a failed load, or every later call fails with the same stale error.
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

/** Measure many texts at once, loading the model only the first time. */
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
