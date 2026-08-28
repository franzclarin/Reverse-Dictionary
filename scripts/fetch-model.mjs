/**
 * Fetch the ONNX embedding model into `models/` at BUILD time, so the serverless
 * function never downloads it at REQUEST time.
 *
 * Why this exists (RD-11): the model is 86MB, and pulling it from the HF CDN on
 * every cold start cost ~39s, of which the actual ONNX session init is ~70ms.
 * The cold start was 99.8% network. Shipping the file inside the function bundle
 * removes the download from the request path entirely.
 *
 * Plain .mjs, not .ts, on purpose: this runs ahead of `next build`, and must not
 * depend on `tsx` resolving.
 *
 * Contract with lib/embedder.ts:
 *   - Layout MUST mirror the HF repo id — models/<org>/<name>/... — because
 *     Transformers.js resolves `pathJoin(env.localModelPath, "<org>/<name>/file")`.
 *   - Only the 4 files below are fetched. The HF repo has 14; the rest
 *     (model.safetensors, the sentence-transformers configs) are never requested
 *     by the feature-extraction pipeline and would just inflate the bundle.
 *   - A failure here MUST fail the build. lib/embedder.ts runs with
 *     `allowRemoteModels = false`, so a missing file is a hard 500 in production
 *     rather than a silent fallback to the slow path — that tradeoff is only safe
 *     if this script is strict.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODEL_ID = "franzclarin/ReverseDictionary";
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const OUT_DIR = path.join(process.cwd(), "models", MODEL_ID);

// Exact byte sizes, verified against the HF repo on 2026-08-27. These are the
// integrity check: a truncated download, an LFS pointer, or an HTML error page
// served with a 200 all fail here instead of shipping a corrupt model.
//
// `onnx/model.onnx` is the fp32 model — there is NO quantized artifact in this
// repo (onnx/model_quantized.onnx returns a 15-byte "Entry not found"), which is
// why lib/embedder.ts pins `quantized: false`.
const FILES = [
  { name: "config.json", bytes: 746 },
  { name: "tokenizer.json", bytes: 711649 },
  { name: "tokenizer_config.json", bytes: 594 },
  { name: "onnx/model.onnx", bytes: 90374450 },
];

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

async function sizeOf(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/**
 * Download one file, verifying its size. Writes to `<dest>.part` and renames on
 * success so an interrupted run can never leave a truncated file in place that
 * a later run would have to catch.
 */
async function fetchFile({ name, bytes }) {
  const dest = path.join(OUT_DIR, name);

  const existing = await sizeOf(dest);
  if (existing === bytes) {
    console.log(`[fetch-model] skip ${name} (present, ${mb(bytes)})`);
    return;
  }
  if (existing !== null) {
    console.warn(
      `[fetch-model] ${name} present but ${existing} bytes, expected ${bytes} — refetching`
    );
  }

  await mkdir(path.dirname(dest), { recursive: true });

  const url = `${BASE_URL}/${name}`;
  const startedAt = Date.now();
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} -> HTTP ${response.status} ${response.statusText}`);
  }

  const partial = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }

  const written = await sizeOf(partial);
  if (written !== bytes) {
    await unlink(partial).catch(() => {});
    throw new Error(
      `${name} downloaded ${written} bytes, expected ${bytes}. ` +
        `Either the HF repo changed (update FILES in this script) or the download was truncated.`
    );
  }

  await rename(partial, dest);
  console.log(
    `[fetch-model] got ${name} (${mb(bytes)}) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
}

async function main() {
  console.log(`[fetch-model] model=${MODEL_ID} -> ${OUT_DIR}`);
  // Sequential, not parallel: the 86MB file dominates, so concurrency buys
  // nothing and only makes a failure harder to read in build logs.
  for (const file of FILES) {
    await fetchFile(file);
  }
  console.log(`[fetch-model] ok — ${FILES.length} files ready`);
}

main().catch((error) => {
  console.error(`[fetch-model] FAILED: ${error?.message ?? error}`);
  console.error(
    "[fetch-model] The build cannot continue: lib/embedder.ts loads this model from disk " +
      "with remote fetching disabled, so shipping without it would break /api/lookup."
  );
  process.exit(1);
});
