import { pipeline, env } from "@xenova/transformers";

// Serverless runtimes have a read-only home dir; /tmp is the only writable
// path. Cache the model there so warm invocations reuse it instead of
// re-downloading ~90MB each time.
env.allowLocalModels = false;
env.cacheDir = "/tmp/transformers_cache";

// Store the loading promise on globalThis so it survives module re-eval and
// dev hot-reloads (one download per warm instance).
const g = globalThis as typeof globalThis & {
  _embedderPromise?: ReturnType<typeof pipeline>;
};

function getEmbedder() {
  if (!g._embedderPromise) {
    g._embedderPromise = pipeline(
      "feature-extraction",
      "franzclarin/ReverseDictionary",
      { quantized: false } // load onnx/model.onnx (not model_quantized.onnx)
    ).catch((err) => {
      // Clear so the next request retries instead of re-throwing a stale error
      g._embedderPromise = undefined;
      throw err;
    });
  }
  return g._embedderPromise;
}

export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  // pooling + normalize reproduce the sentence-transformers pipeline the DB
  // embeddings were generated with (mean Pooling + Normalize).
  const output = await (pipe as (
    t: string,
    o: object
  ) => Promise<{ data: Float32Array }>)(text, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data);
}
