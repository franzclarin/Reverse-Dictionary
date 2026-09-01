/**
 * Download the model into `models/` when the app is BUILT, so the live site
 * never downloads it while someone is waiting.
 *
 * It is 86MB, and fetching it on first use took about 40 seconds against 70
 * milliseconds of actual start-up work — so almost all of that wait was the
 * download. Shipping the file with the app removes it entirely.
 *
 * Plain JavaScript rather than TypeScript on purpose: this runs before the build
 * and must not depend on anything that needs compiling.
 *
 * What the app expects of it: the folder layout must mirror the model's name,
 * because that is how the library looks it up. Only four of the fourteen
 * published files are fetched; the rest are never read and would only bloat the
 * app. And a failure here MUST fail the build, because the app refuses to
 * download anything at run time — so a missing file is a loud error rather than
 * a quiet fallback to the slow path.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODEL_ID = "franzclarin/ReverseDictionary";
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const OUT_DIR = path.join(process.cwd(), "models", MODEL_ID);

// Exact file sizes, which act as the integrity check: a cut-off download, a
// placeholder file, or an error page served as if it were fine all fail here
// instead of shipping a broken model.
//
// There is only one version of this model published — the smaller, faster
// variant does not exist — which is why the app never asks for one.
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

/** Download one file and check its size. */
// Written to a temporary name and renamed on success, so an interrupted run can
// never leave a half-finished file that a later run would have to notice.
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
    // One at a time: the large file dominates anyway, so downloading in parallel
    // buys nothing and only makes a failure harder to read in the build log.
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
