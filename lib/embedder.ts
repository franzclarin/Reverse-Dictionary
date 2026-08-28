import path from "node:path";
import { pipeline, env } from "@xenova/transformers";
import {
  SubsystemError,
  describeError,
  formatErrorShape,
  isNetworkError,
} from "@/lib/errors";

// RD-11: the model ships INSIDE the function bundle and is read from local
// disk. It used to be pulled from the HF CDN on every cold start, which cost
// ~39s against ~70ms of actual ONNX session init — the cold start was 99.8%
// network. `scripts/fetch-model.mjs` downloads it at build time and
// `next.config.js` traces `models/**` into the function.
//
// localModelPath must be set explicitly: Transformers.js defaults it relative
// to its OWN module directory (node_modules/@xenova/transformers), not cwd.
const MODEL_ROOT = path.join(process.cwd(), "models");

/**
 * Point Transformers.js at the bundled model directory.
 *
 * `env` is a PROCESS-WIDE SINGLETON, so this is applied at the call site rather
 * than at module scope. `scripts/lib/embedModel.ts` needs the opposite settings
 * (remote base models, for the eval cells) and configures itself the same way;
 * when both were set at module scope, whichever module body happened to
 * evaluate last silently won and broke the other. Import order is not a
 * contract — configure immediately before use.
 *
 * `allowRemoteModels = false` is the load-bearing half. Without it, a
 * file-tracing miss would silently degrade back to the 39s download in
 * production and nobody would ever notice; with it, the same miss is a loud
 * `model` SubsystemError that surfaces in preview instead.
 */
function configureLocalModelEnv(): void {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = MODEL_ROOT;
}

const MODEL_ID = "franzclarin/ReverseDictionary";
const MAX_LOAD_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

type Embedder = (
  text: string,
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

// Store the loading promise on globalThis so it survives module re-eval and
// dev hot-reloads (one ONNX session init per warm instance).
const g = globalThis as typeof globalThis & {
  _embedderPromise?: Promise<Embedder>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Load the ONNX pipeline from the bundled model directory.
 *
 * Since RD-11 there is no network in this path, so the expected failure is a
 * missing/corrupt file rather than a CDN blip — and `isNetworkError()` breaks
 * out of the loop on attempt 1 for exactly that case, so a tracing miss fails
 * fast instead of burning the function's 60s budget on three identical retries.
 *
 * The retry loop is kept anyway: it costs nothing on the happy path and still
 * covers a genuinely transient filesystem fault on a cold instance.
 */
async function loadEmbedder(): Promise<Embedder> {
  let lastError: unknown;
  // Actual attempts made, which is NOT MAX_LOAD_ATTEMPTS: a non-network
  // failure breaks out after the first. Reporting the constant instead made
  // a single fast failure read as three slow ones.
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    const startedAt = Date.now();
    try {
      configureLocalModelEnv();
      const pipe = (await pipeline("feature-extraction", MODEL_ID, {
        quantized: false, // load onnx/model.onnx (not model_quantized.onnx)
      })) as unknown as Embedder;
      // Log the resolved root: if file tracing ever drops models/, this line is
      // the whole diagnosis rather than a guess about where it looked.
      console.log(
        `[embedder] model loaded model=${MODEL_ID} root=${MODEL_ROOT} ` +
          `attempt=${attempt} ms=${Date.now() - startedAt}`
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
    `Failed to load embedding model "${MODEL_ID}" from ${MODEL_ROOT} after ` +
      `${attemptsMade} attempt(s): ${shape.message}. ` +
      `Expected ${MODEL_ID}/onnx/model.onnx under that directory — locally, run ` +
      `\`npm run fetch-model\`; on a deployment, this means next.config.js's ` +
      `outputFileTracingIncludes did not ship models/ with the function.`,
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
