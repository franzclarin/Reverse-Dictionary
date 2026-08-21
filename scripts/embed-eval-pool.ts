/**
 * Phase E — embed one cell of the 2x2 into the sampled pool tables.
 *
 * Cells:
 *   lemma-ft        fine-tune  x lemma index   (the production representation)
 *   lemma-base      base model x lemma index   (did the fine-tune buy anything?)
 *   gloss-ft        fine-tune  x gloss index   (may be off-distribution: the
 *                                               fine-tune was trained
 *                                               query_to_doc, not gloss-to-gloss)
 *   gloss-base      base model x gloss index   (symmetric model, symmetric task)
 *
 * Gloss-text variants, tested on the base model only to keep the budget sane:
 *   gloss-base-ex   definition + WordNet's quoted example sentences
 *   gloss-base-lem  "<lemma>: <definition>"
 *
 * Cells are written to LOCAL FILES, not to Postgres. The Neon project has a
 * 512 MB size limit and `VocabEmbedding` plus its IVFFlat index already takes
 * 451 MB of it, so there is no room for ~100k experiment vectors and making
 * room would mean touching production data. Storing them locally means the
 * experiment performs no database writes at all, and a brute-force scan over
 * the pool is exact by construction — which isolates the representation
 * change from any approximate-index effect.
 *
 * Search them with `eval.ts --index-file <cell>`.
 *
 *   npx tsx scripts/embed-eval-pool.ts --cell lemma-ft
 *   npx tsx scripts/embed-eval-pool.ts --cell gloss-base --benchmark 200
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./lib/env";
import { embedWith, BASE_MODEL, PRODUCTION_MODEL } from "./lib/embedModel";
import { DIM, cellDir, writeIndex } from "./lib/localIndex";
import { glossTextFor, inputsSha256, bytesSha256 } from "./lib/cellText";
import type { PoolManifest } from "./build-eval-pool";

loadEnv();

const MANIFEST = path.resolve(process.cwd(), "eval/data/pool-manifest.json");

type Representation = "lemma" | "gloss";
type Variant = "lemma" | "gloss" | "gloss_examples" | "lemma_gloss";

type Cell = {
  name: string;
  model: string;
  representation: Representation;
  variant: Variant;
  file: string;
};

const CELLS: Cell[] = [
  { name: "lemma-ft", model: PRODUCTION_MODEL, representation: "lemma", variant: "lemma", file: "eval_lemma_ft" },
  { name: "lemma-base", model: BASE_MODEL, representation: "lemma", variant: "lemma", file: "eval_lemma_base" },
  { name: "gloss-ft", model: PRODUCTION_MODEL, representation: "gloss", variant: "gloss", file: "eval_gloss_ft" },
  { name: "gloss-base", model: BASE_MODEL, representation: "gloss", variant: "gloss", file: "eval_gloss_base" },
  { name: "gloss-base-ex", model: BASE_MODEL, representation: "gloss", variant: "gloss_examples", file: "eval_gloss_base_ex" },
  { name: "gloss-base-lem", model: BASE_MODEL, representation: "gloss", variant: "lemma_gloss", file: "eval_gloss_base_lem" },
];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Text to encode for each row of this cell. */
function textsFor(cell: Cell, manifest: PoolManifest): { key: string; word: string; text: string }[] {
  if (cell.representation === "lemma") {
    return manifest.words.map((word) => ({ key: "lemma", word, text: word }));
  }
  // Text derivation lives in lib/cellText.ts so the verifier uses the exact
  // same definition — a checker with its own copy could drift and pass a wrong
  // cell.
  return manifest.glosses.map((g) => ({
    key: g.senseKey,
    word: g.word,
    text: glossTextFor(cell.variant, g),
  }));
}

async function main(): Promise<void> {
  const name = arg("--cell");
  const cell = CELLS.find((c) => c.name === name);
  if (!cell) {
    console.error(`usage: --cell <${CELLS.map((c) => c.name).join("|")}>`);
    process.exitCode = 1;
    return;
  }
  const benchmark = arg("--benchmark") ? Number(arg("--benchmark")) : 0;
  const dir = arg("--dir") ?? cellDir();

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as PoolManifest;
  let items = textsFor(cell, manifest);
  if (benchmark) items = items.slice(0, benchmark);

  console.log(`Cell "${cell.name}"`);
  console.log(`  model          ${cell.model}`);
  console.log(`  representation ${cell.representation} (variant: ${cell.variant})`);
  console.log(`  pool scale     ${manifest.scale} (${manifest.poolWords.toLocaleString()} words)`);
  console.log(`  rows           ${items.length.toLocaleString()}${benchmark ? "  [BENCHMARK]" : ""}`);
  console.log(`  out            ${path.join(dir, cell.file)}.{vec,json}`);

  process.stdout.write(`
  loading model... `);
  const warmStart = Date.now();
  await embedWith(cell.model, "warm up");
  console.log(`${Date.now() - warmStart}ms
`);

  // One flat buffer rather than an array of arrays: 29,583 x 384 floats is
  // 45 MB contiguous, versus several hundred MB of boxed JS numbers.
  const vectors = new Float32Array(items.length * DIM);
  const words: string[] = [];
  const senseKeys: string[] = [];

  const started = Date.now();
  for (let i = 0; i < items.length; i++) {
    const vector = await embedWith(cell.model, items[i].text);
    vectors.set(vector, i * DIM);
    words.push(items[i].word);
    senseKeys.push(items[i].key);

    if ((i + 1) % 500 === 0 || i + 1 === items.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = (i + 1) / elapsed;
      process.stdout.write(
        `
  embedded ${(i + 1).toLocaleString()}/${items.length.toLocaleString()}  ` +
          `${rate.toFixed(0)}/s  eta ${((items.length - i - 1) / rate / 60).toFixed(1)}m   `
      );
    }
  }

  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `

  ${items.length.toLocaleString()} rows in ${(elapsed / 60).toFixed(1)}m ` +
      `(${(items.length / elapsed).toFixed(0)}/s)`
  );

  if (benchmark) {
    const full = cell.representation === "lemma" ? manifest.words.length : manifest.glosses.length;
    console.log(
      `  projected for the full ${full.toLocaleString()} rows: ` +
        `${(full / (items.length / elapsed) / 60).toFixed(1)} minutes`
    );
    console.log(`  (benchmark: nothing written)
`);
    return;
  }

  const written = writeIndex(
    {
      cell: cell.file,
      model: cell.model,
      variant: cell.variant,
      representation: cell.representation,
      scale: manifest.scale,
      poolWords: manifest.poolWords,
      inputsSha256: inputsSha256(items.map((i) => i.text)),
      vectorsSha256: bytesSha256(
        Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
      ),
      note: manifest.note,
      words,
      senseKeys: cell.representation === "gloss" ? senseKeys : undefined,
    },
    vectors,
    dir
  );

  console.log(
    `  wrote ${path.basename(written.vec)} (${(written.bytes / 1e6).toFixed(1)} MB), ` +
      `${new Set(words).size.toLocaleString()} distinct words
`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
