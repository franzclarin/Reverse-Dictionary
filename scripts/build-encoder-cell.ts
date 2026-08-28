/**
 * Build a FULL-SCALE synset cell straight from WordNet, for any encoder. (RD-16)
 *
 * WHY THIS EXISTS AND `embed-eval-pool.ts` DOES NOT SUFFICE. That script builds
 * from `eval/data/pool-manifest.json` — a *sampled* 20,287-word pool whose
 * absolute recall is deliberately not comparable to production (CLAUDE.md says
 * so, and the measurement bore it out at the cutover). It also hardcodes
 * `DIM`, so it cannot hold a 768-dimensional encoder. RD-16 needs both: numbers
 * on the same 114k synsets production searches, and the freedom to test a wider
 * model. This goes WordNet -> cell with no database and no pool manifest.
 *
 * WHAT A CELL IS FOR. `eval.ts --index-file <cell>` scans it exhaustively, so
 * the result is EXACT — no IVFFlat approximation mixed into the comparison.
 * That is what makes a cell the right instrument for a representation question
 * and the wrong one for a latency question.
 *
 * THE MODEL/QUERY PAIRING IS THE WHOLE HAZARD. Documents encoded by one model
 * and queries by another compare vectors from two different spaces, and the
 * output looks like a representation result rather than the nonsense it is.
 * `eval.ts` defends against this by reading the encoder from `meta.model`, so
 * this script's one non-negotiable duty is to record the model it actually used.
 *
 * MEAN POOLING, NO PREFIX. `embedWith` reproduces the production pipeline
 * (mean pooling, L2 normalise) for every model it is handed. Models that need
 * CLS pooling (BGE) or an instruction prefix (E5, "query: " / "passage: ")
 * would be silently mis-encoded by it and must NOT be built here without
 * teaching the harness's encode path the same rule — the query side has to
 * match or the pairing hazard above applies to prefixes too.
 *
 *   npx tsx scripts/build-encoder-cell.ts --model Xenova/gte-small --out full_gloss_gte
 *   npx tsx scripts/build-encoder-cell.ts --variant gloss_examples --out full_gloss_ft_ex
 *   npx tsx scripts/build-encoder-cell.ts --limit 500        # benchmark; writes nothing
 */
import { embedWith, PRODUCTION_MODEL } from "./lib/embedModel";
import { bytesSha256, glossTextFor, inputsSha256 } from "./lib/cellText";
import { writeIndex, cellDir, type CellMeta } from "./lib/localIndex";
import { POS_LIST, readSenses } from "./lib/wordnet";

/**
 * The harness recognises a synset cell by this exact string
 * (`eval.ts`: `local?.meta.variant === "gloss_synset"`), which is what switches
 * on member expansion. The *text* variant therefore cannot live in this field;
 * it is recorded in the cell name, in `note`, and — bindingly — in
 * `inputsSha256`, which pins the exact ordered text list the cell was built
 * from and is what `verify-eval-pool.ts` recomputes.
 */
const HARNESS_SYNSET_VARIANT = "gloss_synset";

/**
 * The production `GlossEmbedding` row count, as a drift check rather than a
 * requirement. Note this is NOT Phase E's 114,662 — that figure is the sampled
 * pool's collapsed row count, and `build-gloss-index.ts` carries it as a
 * sanity check against full WordNet, where it has never matched.
 */
const EXPECTED_SYNSETS = 117_791;

type Synset = { key: string; words: string[]; gloss: string; examples: string[] };

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * One row per synset, in WordNet's file order.
 *
 * Mirrors `groupBySynset()` in `build-gloss-index.ts`, which builds the
 * production table: every line of `data.<pos>` already IS a synset, so this is
 * a read rather than a grouping. Member order is WordNet's own and is never
 * sorted — `--expansion-order wordnet` reads that order back out of the same
 * files at query time, so a reordering here would silently change the
 * tie-break the production index uses.
 */
function readSynsets(): Synset[] {
  const out: Synset[] = [];
  for (const pos of POS_LIST) {
    for (const sense of readSenses(pos)) {
      out.push({
        key: `${sense.pos}:${sense.offset}`,
        words: sense.words,
        gloss: sense.gloss,
        examples: sense.examples,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const model = arg("--model") ?? PRODUCTION_MODEL;
  const variant = arg("--variant") ?? "gloss";
  const limit = Number(arg("--limit") ?? NaN);
  const benchmark = Number.isFinite(limit) && limit > 0;
  const out = arg("--out") ?? (benchmark ? "benchmark" : undefined);
  const dir = arg("--dir") ?? cellDir();

  if (!out) {
    console.error("--out <cell-name> is required (or use --limit for a benchmark run).");
    process.exitCode = 1;
    return;
  }

  let synsets = readSynsets();
  console.log(`\nWordNet      ${synsets.length.toLocaleString()} synsets across ${POS_LIST.join(", ")}`);
  if (synsets.length !== EXPECTED_SYNSETS) {
    console.log(
      `  NOTE: Phase E counted ${EXPECTED_SYNSETS.toLocaleString()}. A different wordnet-db ` +
        `version is a legitimate cause, but check before comparing this cell to an older one.`
    );
  }
  if (benchmark) synsets = synsets.slice(0, limit);

  // The single definition of what text a variant indexes. A second copy here is
  // exactly the builder/checker drift `cellText.ts` was split out to prevent.
  const texts = synsets.map((s) =>
    glossTextFor(variant, { word: s.words[0], gloss: s.gloss, examples: s.examples })
  );

  console.log(`cell         ${out}${benchmark ? "  [BENCHMARK — nothing written]" : ""}`);
  console.log(`model        ${model}`);
  console.log(`text variant ${variant}`);
  console.log(`rows         ${texts.length.toLocaleString()}`);
  console.log(`out dir      ${dir}`);

  process.stdout.write(`\n  loading model... `);
  const warmStart = Date.now();
  const probe = await embedWith(model, "warm up");
  const dim = probe.length;
  console.log(`${Date.now() - warmStart}ms  (${dim} dimensions)`);

  // One flat buffer: 114,662 x 768 floats is 352 MB contiguous, versus several
  // gigabytes of boxed JS numbers as an array of arrays.
  const vectors = new Float32Array(texts.length * dim);
  const started = Date.now();
  for (let i = 0; i < texts.length; i++) {
    const vector = await embedWith(model, texts[i]);
    if (vector.length !== dim) {
      throw new Error(`row ${i} came back ${vector.length}-dim, expected ${dim}`);
    }
    vectors.set(vector, i * dim);
    if ((i + 1) % 500 === 0 || i + 1 === texts.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = (i + 1) / elapsed;
      process.stdout.write(
        `\r  embedded ${(i + 1).toLocaleString()}/${texts.length.toLocaleString()}  ` +
          `${rate.toFixed(0)}/s  eta ${((texts.length - i - 1) / rate / 60).toFixed(1)}m    `
      );
    }
  }
  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `\n\n  ${texts.length.toLocaleString()} rows in ${(elapsed / 60).toFixed(1)}m ` +
      `(${(texts.length / elapsed).toFixed(0)}/s)`
  );

  if (benchmark) {
    const full = readSynsets().length;
    console.log(
      `  projected for all ${full.toLocaleString()} rows: ` +
        `${(full / (texts.length / elapsed) / 60).toFixed(1)} minutes, ` +
        `${((full * dim * 4) / 1e6).toFixed(0)} MB on disk\n`
    );
    return;
  }

  const words = synsets.map((s) => s.words[0]);
  const synsetMembers: Record<string, string[]> = {};
  for (const s of synsets) synsetMembers[s.key] = s.words;

  const meta: Omit<CellMeta, "dim" | "rows" | "distinctWords" | "builtAt"> = {
    cell: out,
    model,
    variant: HARNESS_SYNSET_VARIANT,
    representation: "gloss",
    // Full WordNet, not the sampled Phase E pool. `report.ts` refuses to table a
    // cross-scale delta, so this field is what keeps these cells from being
    // compared against the 20k ones by accident.
    scale: "full",
    poolWords: new Set(synsets.flatMap((s) => s.words)).size,
    inputsSha256: inputsSha256(texts),
    vectorsSha256: bytesSha256(
      Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
    ),
    note:
      `RD-16 encoder sweep. Full WordNet 3.0: one row per synset, text variant ` +
      `"${variant}", encoded by ${model} with mean pooling and L2 normalisation. ` +
      `Built from wordnet-db directly — no database, no pool manifest — so it covers the ` +
      `same synsets the production GlossEmbedding table does and its absolute recall is ` +
      `comparable to a production run (exact scan here vs probes=40 there). NOT comparable ` +
      `to a sampled Phase E cell.`,
    words,
    senseKeys: synsets.map((s) => s.key),
    synsetMembers,
  };

  const written = writeIndex(meta, vectors, dir, dim);
  console.log(
    `  wrote ${out}.vec (${(written.bytes / 1e6).toFixed(0)} MB), ` +
      `${synsets.length.toLocaleString()} synsets covering ` +
      `${meta.poolWords!.toLocaleString()} words\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
