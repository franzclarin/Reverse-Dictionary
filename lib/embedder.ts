import { pipeline, env } from "@xenova/transformers";

env.allowLocalModels = false;
// On Vercel (and other serverless runtimes) the home dir is read-only;
// /tmp is the only writable path. Point the HF cache there so warm
// invocations reuse the downloaded model instead of re-fetching 90 MB.
env.cacheDir = "/tmp/transformers_cache";

// Store the loading promise on globalThis so dev hot-reloads don't re-download
const g = globalThis as typeof globalThis & {
  _embedderPromise?: ReturnType<typeof pipeline>;
};

function getEmbedder() {
  if (!g._embedderPromise) {
    g._embedderPromise = pipeline(
      "feature-extraction",
      "franzclarin/ReverseDictionary",
      { quantized: false } // use onnx/model.onnx (not model_quantized.onnx)
    ).catch((err) => {
      // Clear so the next request retries rather than re-throwing the same error
      g._embedderPromise = undefined;
      throw err;
    });
  }
  return g._embedderPromise;
}

export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  // pooling + normalize match what the sentence-transformers model was trained with
  const output = await (pipe as (t: string, o: object) => Promise<{ data: Float32Array }>)(
    text,
    { pooling: "mean", normalize: true }
  );
  return Array.from(output.data);
}
