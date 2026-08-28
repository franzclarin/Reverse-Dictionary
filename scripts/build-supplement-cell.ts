/**
 * RD-17 step 4 — the expanded index, as a local cell rather than a table.
 *
 * "Do not touch GlossEmbedding until the numbers exist." `build-encoder-cell.ts`
 * already produces full-scale cells outside Postgres and RD-16's cells
 * cross-validated against a live production run to the digit, so a cell is
 * enough to reach a decision with zero database writes and no rollback path.
 *
 * TWO THINGS THIS SHARES RATHER THAN REBUILDS, and both are the same argument:
 * a delta is only attributable if everything except the thing under test is
 * bit-identical.
 *
 *   1. THE WORDNET HALF. Rows 0..117,790 are copied verbatim out of
 *      `full_gloss_ft.vec` — RD-16's verified control, the same encoder over the
 *      same gloss text in the same order. Not re-embedded. So the control and
 *      the expanded cells hold *the same floats* for every WordNet synset, and
 *      any measured difference is the added rows and nothing else.
 *
 *   2. THE SUPPLEMENT VECTORS. `wikt_new`'s rows are a verified strict subset of
 *      `wikt_all`'s (0 rows differ), so the superset is embedded ONCE and the
 *      narrow arm is a selection out of it. The two arms therefore share
 *      bit-identical vectors wherever they share a row, and the arm difference
 *      is purely the extra senses — which is the number the arms exist to
 *      produce.
 *
 * RESUMABLE. Half a million ONNX forward passes is hours, and a run that dies at
 * 90% must not start over. Vectors append to `<cache>.vec` and a sidecar records
 * how many rows are complete; a restart truncates to that boundary and carries
 * on. The count is written AFTER the flush, so a crash mid-write costs one batch
 * and never leaves a half-row.
 *
 *   npx tsx scripts/build-supplement-cell.ts --benchmark 500
 *   npx tsx scripts/build-supplement-cell.ts --embed
 *   npx tsx scripts/build-supplement-cell.ts --compose
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { embedWith, PRODUCTION_MODEL } from "./lib/embedModel";
import { bytesSha256, inputsSha256 } from "./lib/cellText";
import { cellDir, writeIndex, DIM, type CellMeta } from "./lib/localIndex";
import { sourcePath } from "./lib/sources";
import { FILTER_VERSION, LICENCE, type SupplementRow } from "./lib/wiktionary";
import { POS_LIST, readSenses } from "./lib/wordnet";

/** RD-16's control cell. Its WordNet half is copied, never re-embedded. */
const BASE_CELL = "full_gloss_ft";
const EXPECTED_BASE_ROWS = 117_791;

/** The superset arm. `wikt_new` is selected out of this one's vectors. */
const SUPERSET_ARM = "wikt_all";
const CACHE = "supplement_wikt_all";

/** Rows per flush. Large enough that the write cost disappears, small enough to lose little. */
const FLUSH_ROWS = 2_000;

type Arm = "wikt_new" | "wikt_all";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

// ------------------------------------------------------------------ inputs

async function readSupplement(arm: Arm): Promise<SupplementRow[]> {
  const file = sourcePath(`supplement-${arm}.jsonl`);
  if (!fs.existsSync(file)) {
    throw new Error(`no ${file} — run: npx tsx scripts/build-supplement.ts`);
  }
  const rows: SupplementRow[] = [];
  const stream = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of stream) {
    if (line) rows.push(JSON.parse(line) as SupplementRow);
  }
  return rows;
}

type WordNetRow = { key: string; words: string[]; gloss: string };

/**
 * The base cell's rows, in the order `build-encoder-cell.ts` wrote them.
 *
 * Recomputed from `wordnet-db` rather than stored, exactly as
 * `verify-encoder-cell.ts` does — and for the same reason: if the order here
 * drifted from the order the vectors were written in, row i would describe
 * synset j and nothing downstream would say so. The hash check in
 * `verify-supplement-cell.ts` is what turns that from an assumption into a test.
 */
function readWordNetRows(): WordNetRow[] {
  const out: WordNetRow[] = [];
  for (const pos of POS_LIST) {
    for (const sense of readSenses(pos)) {
      out.push({ key: `${sense.pos}:${sense.offset}`, words: sense.words, gloss: sense.gloss });
    }
  }
  return out;
}

// ------------------------------------------------------------- embed phase

function cachePaths(): { vec: string; progress: string } {
  const dir = cellDir();
  fs.mkdirSync(dir, { recursive: true });
  return {
    vec: path.join(dir, `${CACHE}.vec`),
    progress: path.join(dir, `${CACHE}.progress.json`),
  };
}

async function embedSuperset(benchmark: number): Promise<void> {
  const rows = await readSupplement(SUPERSET_ARM);
  const texts = rows.map((r) => r.gloss);
  const total = benchmark > 0 ? Math.min(benchmark, texts.length) : texts.length;
  const { vec, progress } = cachePaths();

  let done = 0;
  if (benchmark === 0 && fs.existsSync(progress) && fs.existsSync(vec)) {
    const saved = JSON.parse(fs.readFileSync(progress, "utf8")) as { rows: number };
    done = Math.min(saved.rows, total);
    // Trust the counter, not the file length: a crash between the write and the
    // counter update leaves trailing bytes that belong to no completed batch.
    fs.truncateSync(vec, done * DIM * 4);
    console.log(`  resuming at ${done.toLocaleString()}/${total.toLocaleString()}`);
  } else if (benchmark === 0) {
    fs.writeFileSync(vec, Buffer.alloc(0));
  }

  process.stdout.write(`  loading ${PRODUCTION_MODEL}... `);
  const warm = Date.now();
  const probe = await embedWith(PRODUCTION_MODEL, "warm up");
  if (probe.length !== DIM) throw new Error(`model returned ${probe.length} dims, expected ${DIM}`);
  console.log(`${Date.now() - warm}ms`);

  let buffer = new Float32Array(FLUSH_ROWS * DIM);
  let buffered = 0;
  const started = Date.now();

  const flush = (): void => {
    if (!buffered || benchmark > 0) {
      buffered = 0;
      return;
    }
    fs.appendFileSync(vec, Buffer.from(buffer.buffer, 0, buffered * DIM * 4));
    done += buffered;
    buffered = 0;
    // After the append, never before — see the header note on ordering.
    fs.writeFileSync(progress, JSON.stringify({ rows: done, of: total }), "utf8");
  };

  for (let i = done; i < total; i++) {
    const vector = await embedWith(PRODUCTION_MODEL, texts[i]);
    buffer.set(vector, buffered * DIM);
    buffered++;
    if (buffered === FLUSH_ROWS) flush();
    if ((i + 1) % 1000 === 0 || i + 1 === total) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = (i + 1 - (benchmark > 0 ? 0 : 0)) / elapsed;
      process.stdout.write(
        `\r  embedded ${(i + 1).toLocaleString()}/${total.toLocaleString()}  ` +
          `${rate.toFixed(0)}/s  eta ${((total - i - 1) / rate / 60).toFixed(1)}m    `
      );
    }
  }
  flush();

  const elapsed = (Date.now() - started) / 1000;
  console.log(`\n  ${total.toLocaleString()} rows in ${(elapsed / 60).toFixed(1)}m`);
  if (benchmark > 0) {
    const rate = total / elapsed;
    console.log(
      `  projected for all ${texts.length.toLocaleString()} rows: ` +
        `${(texts.length / rate / 60).toFixed(0)} minutes, ` +
        `${((texts.length * DIM * 4) / 1e6).toFixed(0)} MB\n`
    );
  }
}

// ----------------------------------------------------------- compose phase

function loadFloats(file: string, expectedRows: number): Float32Array {
  const buf = fs.readFileSync(file);
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (data.length !== expectedRows * DIM) {
    throw new Error(
      `${path.basename(file)} holds ${data.length / DIM} rows, expected ${expectedRows}`
    );
  }
  return data;
}

async function composeArm(arm: Arm, base: WordNetRow[], baseVectors: Float32Array): Promise<void> {
  const superset = await readSupplement(SUPERSET_ARM);
  const { vec } = cachePaths();
  const supVectors = loadFloats(vec, superset.length);

  // `wikt_new` is a verified strict subset of `wikt_all`, so selecting rather
  // than re-embedding gives the two arms bit-identical vectors wherever they
  // overlap. Identity is by (key, gloss): the key alone would be ambiguous if
  // the filter ever changed sense ordering under a word.
  let rows: SupplementRow[];
  let sourceIndex: number[];
  if (arm === SUPERSET_ARM) {
    rows = superset;
    sourceIndex = superset.map((_, i) => i);
  } else {
    const wanted = new Set(
      (await readSupplement(arm)).map((r) => `${r.key} :: ${r.gloss}`)
    );
    rows = [];
    sourceIndex = [];
    superset.forEach((r, i) => {
      if (wanted.has(`${r.key} :: ${r.gloss}`)) {
        rows.push(r);
        sourceIndex.push(i);
      }
    });
    if (rows.length !== wanted.size) {
      throw new Error(
        `${arm}: ${wanted.size} rows requested but ${rows.length} found in the ${SUPERSET_ARM} ` +
          `cache. The subset relation no longer holds — rebuild the supplement.`
      );
    }
  }

  const out = `full_gloss_${arm}`;
  const totalRows = base.length + rows.length;
  const vectors = new Float32Array(totalRows * DIM);
  vectors.set(baseVectors, 0);
  sourceIndex.forEach((src, i) => {
    vectors.set(
      supVectors.subarray(src * DIM, (src + 1) * DIM),
      (base.length + i) * DIM
    );
  });

  const texts = [...base.map((b) => b.gloss), ...rows.map((r) => r.gloss)];
  const words = [...base.map((b) => b.words[0]), ...rows.map((r) => r.lemmas[0])];
  const senseKeys = [...base.map((b) => b.key), ...rows.map((r) => r.key)];
  const members: Record<string, string[]> = {};
  for (const b of base) members[b.key] = b.words;
  for (const r of rows) members[r.key] = r.lemmas;

  const meta: Omit<CellMeta, "dim" | "rows" | "distinctWords" | "builtAt"> = {
    cell: out,
    model: PRODUCTION_MODEL,
    // The exact string `eval.ts` switches member expansion on. The *vocabulary*
    // this cell holds lives in `vocabulary` below, never in this field.
    variant: "gloss_synset",
    representation: "gloss",
    scale: "full",
    vocabulary: "wordnet+wiktionary",
    supplementArm: arm,
    filterVersion: FILTER_VERSION,
    poolWords: new Set(
      [...base.flatMap((b) => b.words), ...rows.flatMap((r) => r.lemmas)]
    ).size,
    inputsSha256: inputsSha256(texts),
    vectorsSha256: bytesSha256(
      Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
    ),
    note:
      `RD-17 vocabulary expansion, arm "${arm}". Rows 0..${base.length - 1} are WordNet 3.0 ` +
      `synsets copied VERBATIM from ${BASE_CELL} (not re-embedded), so the control's vectors ` +
      `are bit-identical here and any delta is the added rows alone. Rows ${base.length}.. are ` +
      `Wiktionary senses (filter ${FILTER_VERSION}) encoded by ${PRODUCTION_MODEL} with mean ` +
      `pooling and L2 normalisation. ${LICENCE} NOT comparable to a sampled Phase E cell, and ` +
      `not comparable to a wordnet-only cell on absolute recall for the coverage slice.`,
    words,
    senseKeys,
    synsetMembers: members,
  };

  // The row list, in order, with the exact text each row was built from. The
  // RD-16 verifier recomputes its input hash from wordnet-db and would correctly
  // reject a composed cell; this is what a composed cell is checked against.
  const manifest = path.join(cellDir(), `${out}.manifest.jsonl`);
  const stream = fs.createWriteStream(manifest, { encoding: "utf8" });
  const lines: string[] = [];
  for (let i = 0; i < totalRows; i++) {
    lines.push(
      JSON.stringify({
        key: senseKeys[i],
        word: words[i],
        text: texts[i],
        source: i < base.length ? "wordnet" : "wiktionary",
      }) + "\n"
    );
    if (lines.length >= 5000) {
      stream.write(lines.join(""));
      lines.length = 0;
    }
  }
  stream.write(lines.join(""));
  await new Promise<void>((resolve) => stream.end(resolve));

  const written = writeIndex(meta, vectors, cellDir(), DIM);
  console.log(
    `  ${out}: ${totalRows.toLocaleString()} rows ` +
      `(${base.length.toLocaleString()} wordnet + ${rows.length.toLocaleString()} wiktionary), ` +
      `${(written.bytes / 1e6).toFixed(0)} MB, ${meta.poolWords!.toLocaleString()} words`
  );
}

async function main(): Promise<void> {
  const benchmark = Number(arg("--benchmark") ?? 0);
  const doEmbed = has("--embed") || benchmark > 0;
  const doCompose = has("--compose");
  const only = arg("--arm") as Arm | undefined;

  console.log("\nRD-17 · supplement cell\n");

  if (doEmbed) await embedSuperset(benchmark);
  if (benchmark > 0) return;

  if (doCompose) {
    const base = readWordNetRows();
    if (base.length !== EXPECTED_BASE_ROWS) {
      throw new Error(
        `wordnet-db yields ${base.length} synsets, but ${BASE_CELL} was built over ` +
          `${EXPECTED_BASE_ROWS}. A different wordnet-db version would misalign every copied row.`
      );
    }
    const baseVectors = loadFloats(path.join(cellDir(), `${BASE_CELL}.vec`), base.length);
    console.log(`  base ${BASE_CELL}: ${base.length.toLocaleString()} rows copied verbatim\n`);
    for (const arm of (only ? [only] : ["wikt_new", "wikt_all"]) as Arm[]) {
      await composeArm(arm, base, baseVectors);
    }
    console.log("");
  }

  if (!doEmbed && !doCompose) {
    console.log("  nothing to do — pass --embed, --compose, or --benchmark <n>\n");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
