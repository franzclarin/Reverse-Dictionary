import { pipeline, env } from "@xenova/transformers";
import {
  SubsystemError,
  describeError,
  formatErrorShape,
  isNetworkError,
} from "@/lib/errors";

// Serverless runtimes have a read-only home dir; /tmp is the only writable
// path. Cache the model there so warm invocations reuse it instead of
// re-downloading ~90MB each time.
env.allowLocalModels = false;
env.cacheDir = "/tmp/transformers_cache";

const MODEL_ID = "franzclarin/ReverseDictionary";
const MAX_LOAD_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

type Embedder = (
  text: string,
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

// Store the loading promise on globalThis so it survives module re-eval and
// dev hot-reloads (one download per warm instance).
const g = globalThis as typeof globalThis & {
  _embedderPromise?: Promise<Embedder>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Load the ONNX pipeline, retrying transient network failures.
 *
 * The model is pulled from the Hugging Face CDN on every cold start, so a
 * DNS blip, a rate-limited CDN, or a stalled redirect surfaces here as
 * undici's opaque "fetch failed". Retrying with backoff turns most of those
 * into a slow success instead of a 500.
 */
async function loadEmbedder(): Promise<Embedder> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const pipe = (await pipeline("feature-extraction", MODEL_ID, {
        quantized: false, // load onnx/model.onnx (not model_quantized.onnx)
      })) as unknown as Embedder;
      console.log(
        `[embedder] model loaded model=${MODEL_ID} attempt=${attempt} ms=${Date.now() - startedAt}`
      );
      return pipe;
    } catch (error) {
      lastError = error;
      const shape = describeError(error);
      console.error(
        `[embedder] load failed model=${MODEL_ID} attempt=${attempt}/${MAX_LOAD_ATTEMPTS} ` +
          `ms=${Date.now() - startedAt} ${formatErrorShape(shape)}`
      );
      if (shape.stack) console.error(`[embedder] stack: ${shape.stack}`);

      // A non-network failure (bad model id, ONNX runtime missing) will fail
      // identically on every retry — don't burn the function's 60s budget.
      if (!isNetworkError(shape)) break;
      if (attempt < MAX_LOAD_ATTEMPTS) {
        const backoff = BASE_BACKOFF_MS * 3 ** (attempt - 1);
        console.warn(`[embedder] retrying in ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }

  const shape = describeError(lastError);
  throw new SubsystemError(
    "model",
    `Failed to load embedding model "${MODEL_ID}" after ${MAX_LOAD_ATTEMPTS} attempt(s): ${shape.message}`,
    { cause: lastError }
  );
}

function getEmbedder(): Promise<Embedder> {
  if (!g._embedderPromise) {
    // Assign the *guarded* promise, then clear the slot on rejection. Caching
    // a rejected promise would make every later request on this warm instance
    // fail instantly with the same stale error, even after the network heals.
    const promise = loadEmbedder();
    g._embedderPromise = promise;
    promise.catch(() => {
      if (g._embedderPromise === promise) {
        g._embedderPromise = undefined;
        console.warn("[embedder] cleared cached loader promise; next request will retry");
      }
    });
  }
  return g._embedderPromise;
}

export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  // pooling + normalize reproduce the sentence-transformers pipeline the DB
  // embeddings were generated with (mean Pooling + Normalize).
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}
