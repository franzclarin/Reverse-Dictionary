/**
 * Build `eval_gloss_base_synset` — one row per synset instead of one per
 * (word, sense) — as a pure dedupe pass over an existing gloss cell.
 *
 * NO RE-EMBEDDING. Every word in a WordNet synset shares one gloss, so the
 * gloss cells already hold that identical text once per synonym, and the
 * resulting vectors are bit-identical. Collapsing them is a lossless rewrite of
 * bytes already computed, which is why this takes seconds rather than an hour.
 *
 * WHY IT MATTERS. 204,549 gloss rows collapse to ~114,662 distinct ones: about
 * 44% of the gloss index is duplicated storage and duplicated scan work. In a
 * database with a 512 MB ceiling that is the difference between a gloss index
 * fitting alongside `VocabEmbedding` and not.
 *
 * THE SAFETY PROPERTY. Mate vectors are asserted bit-identical BEFORE
 * collapsing. If any synset's rows disagree, the build stops and reports them
 * rather than silently averaging or picking one — a disagreement would mean the
 * indexed text is not actually per-synset, which is a finding, not a nuisance.
 * (`gloss_base_ex` is the variant where that is expected: WordNet's example
 * sentences are attached per sense, so its rows may legitimately differ. Run it
 * with `--analyse-only` to see, and do not build a synset cell from it.)
 *
 * THE SCORING SURFACE DIFFERS. A synset row expands to several words at query
 * time, so one retrieved synset can consume several top-10 slots. That makes
 * this cell's numbers NOT a drop-in substitute for `eval_gloss_base` in the 2x2.
 * It is reported separately, always.
 *
 *   npx tsx scripts/build-synset-cell.ts
 *   npx tsx scripts/build-synset-cell.ts --from eval_gloss_base_ex --analyse-only
 */
import fs from "node:fs";
import path from "node:path";
import { DIM, cellDir, loadIndex, writeIndex, type CellMeta } from "./lib/localIndex";
import { bytesSha256, inputsSha256 } from "./lib/cellText";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Exact float-by-float comparison. Identical input text must give identical bytes. */
function sameVector(data: Float32Array, a: number, b: number): boolean {
  const oa = a * DIM;
  const ob = b * DIM;
  for (let j = 0; j < DIM; j++) {
    if (data[oa + j] !== data[ob + j]) return false;
  }
  return true;
}

function main(): void {
  const from = arg("--from") ?? "eval_gloss_base";
  const analyseOnly = process.argv.includes("--analyse-only");
  const outName = arg("--out") ?? `${from}_synset`;
  const dir = cellDir();

  const src = loadIndex(from);
  if (src.meta.representation !== "gloss" || !src.meta.senseKeys) {
    console.error(`${from} is not a gloss cell with senseKeys — nothing to collapse.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Source cell   ${from}`);
  console.log(`  model       ${src.meta.model}`);
  console.log(`  variant     ${src.meta.variant}`);
  console.log(`  scale       ${src.meta.scale ?? "sampled"}`);
  console.log(`  rows        ${src.meta.rows.toLocaleString()}\n`);

  // ------------------------------------------------- group rows by synset
  const groups = new Map<string, number[]>();
  const keys = src.meta.senseKeys;
  for (let i = 0; i < src.meta.rows; i++) {
    const k = keys[i];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(i);
  }

  // ------------------------------------- assert mates are bit-identical
  const divergent: { key: string; words: string[] }[] = [];
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    for (let n = 1; n < rows.length; n++) {
      if (!sameVector(src.data, rows[0], rows[n])) {
        divergent.push({ key, words: rows.map((r) => src.meta.words[r]) });
        break;
      }
    }
  }

  const multi = [...groups.values()].filter((r) => r.length > 1).length;
  console.log(`  distinct synsets      ${groups.size.toLocaleString()}`);
  console.log(`  synsets with >1 row   ${multi.toLocaleString()}`);
  console.log(
    `  rows saved by collapse ${(src.meta.rows - groups.size).toLocaleString()} ` +
      `(${(((src.meta.rows - groups.size) / src.meta.rows) * 100).toFixed(1)}% of the index)`
  );
  console.log(`  synsets with DIVERGENT vectors ${divergent.length.toLocaleString()}`);

  if (divergent.length) {
    console.log(
      `\n  Rows inside these synsets do not hold identical vectors, so the indexed text\n` +
        `  is not purely per-synset. Reporting rather than merging — a silent merge would\n` +
        `  destroy a real difference. First ${Math.min(10, divergent.length)}:\n`
    );
    for (const d of divergent.slice(0, 10)) {
      console.log(`    ${d.key}  ${d.words.slice(0, 6).join(", ")}`);
    }
    console.log("");
  }

  // --------------------------------------------------------- storage note
  const sizes = (rows: number, dim: number, bytesPer: number) => (rows * dim * bytesPer) / 1e6;
  console.log(`\n  Storage, as a Postgres index:`);
  console.log(
    `    per-sense  vector(384)   ${sizes(src.meta.rows, 384, 4).toFixed(0)} MB   ` +
      `halfvec(384) ${sizes(src.meta.rows, 384, 2).toFixed(0)} MB   ` +
      `halfvec(256) ${sizes(src.meta.rows, 256, 2).toFixed(0)} MB`
  );
  console.log(
    `    per-synset vector(384)   ${sizes(groups.size, 384, 4).toFixed(0)} MB   ` +
      `halfvec(384) ${sizes(groups.size, 384, 2).toFixed(0)} MB   ` +
      `halfvec(256) ${sizes(groups.size, 256, 2).toFixed(0)} MB`
  );
  console.log(
    `\n    At halfvec(256) the per-synset index is ~${sizes(groups.size, 256, 2).toFixed(0)} MB, which is what makes\n` +
      `    running it alongside VocabEmbedding feasible inside the 512 MB ceiling.\n` +
      `    These are vector-payload figures only; pgvector index overhead is extra.`
  );

  if (analyseOnly) {
    console.log(`\n  --analyse-only: nothing written.\n`);
    return;
  }
  if (divergent.length) {
    console.log(
      `\n  REFUSING TO BUILD: ${divergent.length} synsets have divergent vectors. Collapsing\n` +
        `  them would discard a real difference. Investigate, or run --analyse-only.\n`
    );
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------------------- write the cell
  const orderedKeys = [...groups.keys()];
  const vectors = new Float32Array(orderedKeys.length * DIM);
  const words: string[] = [];
  const synsetMembers: Record<string, string[]> = {};

  orderedKeys.forEach((key, i) => {
    const rows = groups.get(key)!;
    // Every row in the group is bit-identical by the assertion above, so the
    // first is the group.
    vectors.set(src.data.subarray(rows[0] * DIM, rows[0] * DIM + DIM), i * DIM);
    const members = [...new Set(rows.map((r) => src.meta.words[r]))];
    words.push(members[0]);
    synsetMembers[key] = members;
  });

  const meta: Omit<CellMeta, "dim" | "rows" | "distinctWords" | "builtAt"> = {
    cell: outName,
    model: src.meta.model,
    variant: "gloss_synset",
    representation: "gloss",
    scale: src.meta.scale,
    poolWords: src.meta.poolWords,
    // Derived from an existing cell rather than from text, so the input
    // fingerprint is over the ordered synset keys — the thing that actually
    // determines this cell's contents.
    inputsSha256: inputsSha256(orderedKeys),
    vectorsSha256: bytesSha256(
      Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
    ),
    note:
      `Per-synset collapse of ${from} (no re-embedding; mate vectors verified ` +
      `bit-identical). One row per synset; expands to member words at query time in ` +
      `descending Zipf order, so a single retrieved synset can consume several top-k ` +
      `slots. The scoring surface therefore DIFFERS from a per-sense gloss cell: report ` +
      `this cell separately and never as a substitute for ${from} in the 2x2. ` +
      `Source pool: ${src.meta.note}`,
    words,
    senseKeys: orderedKeys,
    synsetMembers,
  };

  const written = writeIndex(meta, vectors, dir);
  console.log(
    `\n  wrote ${path.basename(written.vec)} (${(written.bytes / 1e6).toFixed(1)} MB), ` +
      `${orderedKeys.length.toLocaleString()} synsets covering ` +
      `${new Set(Object.values(synsetMembers).flat()).size.toLocaleString()} words`
  );
  console.log(`  search it with: npx tsx scripts/eval.ts --index-file ${outName} ...\n`);
}

main();
