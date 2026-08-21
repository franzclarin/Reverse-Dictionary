/**
 * Integrity check for the Phase E cells.
 *
 * Deliberately does NOT touch the eval set — the authored slice is under
 * review and must not be scored until the edited TSV comes back. This checks
 * the machinery instead, using each cell's own indexed text as the query:
 *
 *   - lemma cells: embed the word itself. Must return that word at rank 1;
 *     anything else means the vectors and the word list are misaligned.
 *   - gloss cells: embed a sense's own gloss text. Must return a row from THAT
 *     SYNSET at rank 1. Not that exact lemma: a synset's words all share one
 *     gloss, so their vectors are identical and rank 1 among them is an
 *     arbitrary tie-break. Scoring the lemma would fail a healthy cell.
 *
 * Also confirms every cell matches the current pool manifest, since a cell
 * built from a different pool would win or lose on coverage rather than
 * representation.
 *
 *   npx tsx scripts/verify-eval-pool.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./lib/env";
import { embedWith } from "./lib/embedModel";
import { loadIndex, searchLocal, searchLocalRows, cellDir, scaleOf } from "./lib/localIndex";
import { cellInputTexts, glossTextFor, inputsSha256 } from "./lib/cellText";
import type { PoolManifest } from "./build-eval-pool";

loadEnv();

const MANIFEST = path.resolve(process.cwd(), "eval/data/pool-manifest.json");
const CELLS = [
  "eval_lemma_ft",
  "eval_lemma_base",
  "eval_gloss_ft",
  "eval_gloss_base",
  "eval_gloss_base_ex",
  "eval_gloss_base_lem",
];
const SAMPLE = 60;

function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  console.log(`cell dir: ${cellDir()}\n`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as PoolManifest;

  // ------------------------------------------------------- matched pools
  //
  // Checked against the MANIFEST rather than against each other. Cell-to-cell
  // agreement would still pass if every cell were built from the same stale
  // pool, and a rebuild at a different scale is exactly the situation that
  // produces stale cells.
  console.log(`Pool identity — manifest is ${manifest.scale} scale, ${manifest.poolWords.toLocaleString()} words\n`);
  const manifestWords = new Set(manifest.words);
  const fresh: string[] = [];
  const stale: string[] = [];

  for (const cell of CELLS) {
    let idx;
    try {
      idx = loadIndex(cell);
    } catch {
      console.log(`  ${cell.padEnd(24)} *** MISSING ***`);
      stale.push(cell);
      continue;
    }
    const words = new Set(idx.meta.words);
    const sameWords =
      words.size === manifestWords.size && [...words].every((w) => manifestWords.has(w));
    const scale = scaleOf(idx.meta);

    // Provenance fingerprint: recompute the ordered input text list from the
    // manifest and compare it against what the cell says it was built from. A
    // word set can match while the indexed TEXT does not — a gloss cell built
    // under a different variant, say — and after nine concurrent processes once
    // wrote overlapping outputs, "the timestamps look right" is not good enough.
    let fingerprint = "";
    let hashOk = true;
    if (sameWords) {
      const want = inputsSha256(
        cellInputTexts(idx.meta.representation, idx.meta.variant, manifest)
      );
      if (idx.meta.inputsSha256 === undefined) {
        fingerprint = "*** NO INPUT HASH — run backfill-cell-hashes.ts ***";
        hashOk = false;
      } else if (idx.meta.inputsSha256 === want) {
        fingerprint = "inputs " + want.slice(0, 12) + "… OK";
      } else {
        fingerprint = "*** INPUT HASH MISMATCH — cell does not index what it claims ***";
        hashOk = false;
      }
    }

    const same = sameWords && hashOk;
    (same ? fresh : stale).push(cell);
    console.log(
      `  ${cell.padEnd(24)} ${idx.meta.rows.toString().padStart(7)} rows  ` +
        `${words.size.toLocaleString().padStart(9)} words  scale=${scale.padEnd(7)} ` +
        `${sameWords ? "MATCHES MANIFEST" : "*** STALE — built from a different pool ***"}`
    );
    if (fingerprint) console.log(`${" ".repeat(28)}${fingerprint}`);
  }

  if (stale.length) {
    console.log(
      `\n  ${stale.length} cell(s) are not from this manifest, or failed the input-hash check.\n` +
        `  A hash mismatch counts the same as staleness: the cell does not index what it\n` +
        `  claims to. Fewer distractors is also a strictly easier task, so these are
` +
        `  skipped rather than scored as misses. Rebuild them, or never cross the boundary.`
    );
  }

  const targetsInPool = manifest.targets.filter((t) => manifestWords.has(t)).length;
  console.log(
    `\n  draft targets present in the pool: ${targetsInPool}/${manifest.targets.length}`
  );

  // ------------------------------------------------ self-retrieval check
  console.log(`\nSelf-retrieval (each cell queried with its own indexed text, n=${SAMPLE})`);
  console.log(`  a rank-1 miss means vectors and words are misaligned\n`);

  const rand = rng(7);
  const glossSample = Array.from({ length: SAMPLE }, () =>
    manifest.glosses[Math.floor(rand() * manifest.glosses.length)]
  );
  const wordSample = Array.from({ length: SAMPLE }, () =>
    manifest.words[Math.floor(rand() * manifest.words.length)]
  );

  for (const cell of fresh) {
    const idx = loadIndex(cell);
    const isLemma = idx.meta.representation === "lemma";
    let pass = 0; // the integrity criterion
    let exactWord = 0; // informational only, for gloss cells
    let top10 = 0;
    const misses: string[] = [];

    for (let i = 0; i < SAMPLE; i++) {
      if (isLemma) {
        const want = wordSample[i];
        const vector = await embedWith(idx.meta.model, want);
        const hits = searchLocal(idx, vector, { k: 10 });
        const rank = hits.findIndex((h) => h.word === want) + 1;
        if (rank === 1) pass++;
        if (rank >= 1) top10++;
        else if (misses.length < 3) misses.push(`${want} -> ${hits[0]?.word ?? "(nothing)"}`);
        continue;
      }

      // Gloss cell. The criterion is the SYNSET, not the lemma: a synset's
      // words all carry the same gloss, so their vectors are identical and
      // rank 1 among them is an arbitrary tie-break. Scoring the exact lemma
      // would measure tie-breaking and call a healthy cell broken.
      const g = glossSample[i];
      const text = glossTextFor(idx.meta.variant, g);

      const vector = await embedWith(idx.meta.model, text);
      const hits = searchLocalRows(idx, vector, 10);
      if (hits[0]?.senseKey === g.senseKey) pass++;
      if (hits[0]?.word === g.word) exactWord++;
      if (hits.some((h) => h.senseKey === g.senseKey)) top10++;
      else if (misses.length < 3)
        misses.push(
          `${g.word} [${g.senseKey}] -> ${hits[0]?.word} [${hits[0]?.senseKey}] ` +
            `cos=${hits[0]?.similarity.toFixed(4)}`
        );
    }

    const detail = isLemma
      ? ""
      : `   (exact lemma at rank 1: ${exactWord}/${SAMPLE} — tie-break among synonyms, not a defect)`;
    console.log(
      `  ${cell.padEnd(24)} ${isLemma ? "word" : "synset"} rank1 ${String(pass).padStart(3)}/${SAMPLE}   ` +
        `top10 ${String(top10).padStart(3)}/${SAMPLE}${detail}`
    );
    for (const m of misses) console.log(`      MISS: ${m}`);
  }

  console.log(
    `\n  Criterion. Lemma cells: the query IS the indexed text, so anything below\n` +
      `  ${SAMPLE}/${SAMPLE} means the vector buffer and the word list have drifted.\n` +
      `  Gloss cells: scored by SYNSET. WordNet gives a synset one gloss shared by all\n` +
      `  its words, so the pool holds that identical text once per synonym — identical\n` +
      `  vectors, and rank 1 among them is arbitrary. Measured: 24/24 of the exact-lemma\n` +
      `  "misses" were synset-mates at cosine 1.0000 and 0 came from another synset.\n` +
      `  A gloss cell must therefore be at or near ${SAMPLE}/${SAMPLE} on SYNSET rank 1;\n` +
      `  its exact-lemma rate is tie-breaking and carries no information about integrity.\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
