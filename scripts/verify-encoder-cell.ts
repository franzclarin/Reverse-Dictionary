/**
 * Integrity check for the full-size experiment files.
 *
 * The other checker does this job for the sampled ones, but it compares each
 * against a recorded pool, and these have none — they are built straight from
 * the dictionary. Same criteria, different source of truth:
 *
 *   1. Fingerprint. Rebuild the ordered text list from the dictionary and
 *      compare. This is the strong check: it proves the file indexes exactly
 *      what the dictionary yields today, in the same order, so row 5 really does
 *      describe entry 5.
 *
 *      It also reveals WHICH text was indexed. Every file here carries the same
 *      label, because that label is what switches on expansion in the scorer, so
 *      the label cannot say whether the rows hold definitions or definitions
 *      plus examples. Fingerprinting each possibility and reporting which one
 *      matches recovers that from the file itself rather than from a label — and
 *      a file matching none of them is stale, which a label would never reveal.
 *
 *   2. Can it find itself? Measure a sample of the file's own text and require a
 *      row from that meaning back first. A perfect score is not expected: some
 *      definitions are shared word for word by more than one entry, so a handful
 *      are genuinely indistinguishable. Well below that means the numbers and
 *      the keys are out of step.
 *
 *   npx tsx scripts/verify-encoder-cell.ts full_gloss_ft full_gloss_gte
 *   npx tsx scripts/verify-encoder-cell.ts            # every cell in EVAL_CELL_DIR
 */
import fs from "node:fs";
import path from "node:path";
import { embedWith } from "./lib/embedModel";
import { cellDir, loadIndex, searchLocalRows } from "./lib/localIndex";
import { glossTextFor, inputsSha256 } from "./lib/cellText";
import { POS_LIST, readSenses } from "./lib/wordnet";

const SAMPLE = 60;
/** Every text variant a file in this family could hold. */
const VARIANTS = ["gloss", "gloss_examples", "lemma_gloss"];

type Synset = { key: string; words: string[]; gloss: string; examples: string[] };

/** Fixed sampling, so a re-run checks the same rows. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  const dir = cellDir();
  const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const cells = named.length
    ? named
    : fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.basename(f, ".json"))
        .sort();

  if (!cells.length) {
    console.error(`no cells in ${dir}`);
    process.exitCode = 1;
    return;
  }

  const synsets = readSynsets();
  const texts = new Map(
    VARIANTS.map((v) => [
      v,
      synsets.map((s) => glossTextFor(v, { word: s.words[0], gloss: s.gloss, examples: s.examples })),
    ])
  );
  const hashes = new Map([...texts].map(([v, t]) => [inputsSha256(t), v]));
  console.log(`\nWordNet   ${synsets.length.toLocaleString()} synsets   cells in ${dir}\n`);

  let failed = 0;
  const rand = rng(7);
  const sample = Array.from({ length: SAMPLE }, () => Math.floor(rand() * synsets.length));

  for (const cell of cells) {
    const idx = loadIndex(cell, dir);
    const variant = idx.meta.inputsSha256 ? hashes.get(idx.meta.inputsSha256) : undefined;

    console.log(`  ${cell}`);
    console.log(
      `    ${idx.meta.rows.toLocaleString()} rows x ${idx.meta.dim}d   ${idx.meta.model}`
    );

    if (!variant) {
      failed++;
      console.log(
        `    *** INPUT HASH MATCHES NO VARIANT — the cell does not index the text it claims.\n` +
          `        Rebuild it. Do not score it; a stale cell wins or loses on content, not\n` +
          `        representation, and nothing downstream would reveal that.\n`
      );
      continue;
    }
    console.log(`    input hash   OK — text variant is "${variant}"`);

    const cellTexts = texts.get(variant)!;
    let pass = 0;
    let top10 = 0;
    const misses: string[] = [];
    for (const i of sample) {
      const vector = await embedWith(idx.meta.model, cellTexts[i]);
      const hits = searchLocalRows(idx, vector, 10);
      if (hits[0]?.senseKey === synsets[i].key) pass++;
      if (hits.some((h) => h.senseKey === synsets[i].key)) top10++;
      else if (misses.length < 3) {
        misses.push(
          `${synsets[i].words[0]} [${synsets[i].key}] -> ${hits[0]?.word} [${hits[0]?.senseKey}]`
        );
      }
    }
    const ok = pass >= 57;
    if (!ok) failed++;
    console.log(
      `    self-retrieval  synset at rank 1: ${pass}/${SAMPLE}   in top 10: ${top10}/${SAMPLE}   ` +
        `${ok ? "OK" : "*** BELOW 57/60 — vectors and keys are misaligned ***"}`
    );
    for (const m of misses) console.log(`      MISS: ${m}`);
    console.log("");
  }

  console.log(
    `  Criterion: 57-60/60 by SYNSET. Not 60/60 — 482 gloss texts are shared by more than\n` +
      `  one synset (1.1% of the index), and those are genuinely indistinguishable, so a\n` +
      `  small number of collisions is expected rather than a defect.\n`
  );
  if (failed) {
    console.log(`  ${failed} cell(s) FAILED.\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
