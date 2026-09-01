import path from "node:path";
import { pipeline, env } from "@xenova/transformers";
import {
  SubsystemError,
  describeError,
  formatErrorShape,
  isNetworkError,
} from "@/lib/errors";

// The model is shipped with the app and read from disk. It used to be
// downloaded on first use, which took about 40 seconds.
const MODEL_ROOT = path.join(process.cwd(), "models");

/** Point the model loader at our own copy on disk. */
// These settings are global, so set them right before use, never at the top of
// a file: whichever file loads last would silently win and break the other.
// Turning off downloads matters — otherwise a packaging mistake quietly falls
// back to the slow download instead of failing loudly.
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
  options: { pooling: "mean" | "none"; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

// Kept on globalThis so it survives reloads and the model is only started once.
const g = globalThis as typeof globalThis & {
  _embedderPromise?: Promise<Embedder>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Load the model from disk. */
// Retries only help a passing glitch; a missing file fails the same way every
// time, so give up at once rather than spend the time budget on repeats.
async function loadEmbedder(): Promise<Embedder> {
  let lastError: unknown;
  // Tries actually made, which may be fewer than the maximum.
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    const startedAt = Date.now();
    try {
      configureLocalModelEnv();
      const pipe = (await pipeline("feature-extraction", MODEL_ID, {
        quantized: false, // there is only one version of this model on disk
      })) as unknown as Embedder;
      // Log where it looked, so a packaging mistake diagnoses itself.
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
    // Forget a failed load. Remembering one would make every later request fail
    // instantly with the same stale error, even after the problem is fixed.
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

/** Turn a piece of text into the numbers that represent its meaning. */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  // These two settings have to match how the stored words were measured, or
  // the question and the answers end up on different scales.
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/** The same, plus the numbers for each individual word part. Not used by search. */
// /explain animates those parts averaging together, so they must be the real
// ones. Averaging them here gives exactly what `embed()` returns, and
// `scripts/verify-viz-snapshot.ts` proves that stays true.
export async function embedTokens(
  text: string
): Promise<{ tokenVectors: number[][]; pooled: number[] }> {
  const pipe = await getEmbedder();
  const output = await pipe(text, { pooling: "none", normalize: false });

  const [, sequence, dim] = output.dims;
  if (output.dims.length !== 3 || output.data.length !== sequence * dim) {
    throw new SubsystemError(
      "model",
      `unexpected token-embedding shape [${output.dims.join(", ")}] for ${output.data.length} values`
    );
  }

  const tokenVectors: number[][] = [];
  const sum = new Float64Array(dim);
  for (let t = 0; t < sequence; t++) {
    const offset = t * dim;
    const vector = new Array<number>(dim);
    for (let i = 0; i < dim; i++) {
      const value = output.data[offset + i];
      vector[i] = value;
      sum[i] += value;
    }
    tokenVectors.push(vector);
  }

  // Average the parts, then scale to a standard length — the same two steps the
  // stored words went through.
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    sum[i] /= sequence;
    norm += sum[i] * sum[i];
  }
  norm = Math.sqrt(norm) || 1;

  const pooled = new Array<number>(dim);
  for (let i = 0; i < dim; i++) pooled[i] = sum[i] / norm;

  return { tokenVectors, pooled };
}
