/**
 * Phase E — select the sampled candidate pool and stage its gloss text.
 *
 * The 2x2 (fine-tune vs base model) x (lemma index vs gloss index) is run on a
 * pool of every word in VocabEmbedding that carries a WordNet gloss. It was
 * originally a ~20k sample, sized to fit Neon's 512 MB ceiling; that constraint
 * vanished when the cells moved to local files, and sampling actively attenuates
 * the effect under study (see METHODS.md §10), so the pool is now full scale.
 * Pass --distractors to rebuild a sampled pool instead.
 *
 * MATCHED POOLS. Every cell searches exactly the same word set. Words are
 * drawn from `VocabEmbedding` (so the gloss index cannot win on coverage) and
 * further restricted to words that have at least one WordNet sense (so the
 * lemma index cannot win on coverage either). Any word that cannot appear in
 * all four cells appears in none.
 *
 * This is deliberately NOT how the production index would be built. For that,
 * the pool would be the full WordNet lemma set, which also repairs the ~5%
 * coverage tax for free (`adore`, `convene`, `doff`, `abrogate` come back).
 * The two builds are kept distinct and the run metadata says which is which.
 *
 * Writes only to new `EvalPool*` tables. `VocabEmbedding` and its IVFFlat index
 * are never touched.
 *
 *   npx tsx scripts/build-eval-pool.ts --full          # every eligible word
 *   npx tsx scripts/build-eval-pool.ts --distractors 20000
 *
 * Rebuilding the manifest orphans any cell built from the previous pool.
 * `verify-eval-pool.ts` detects that and refuses to score the stale cells rather
 * than reporting them as misses.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { POS_LIST, readSenses, type Sense } from "./lib/wordnet";
import { AUTHORED } from "./data/authored-v1";

loadEnv();

const prisma = new PrismaClient();
const MANIFEST = path.resolve(process.cwd(), "eval/data/pool-manifest.json");

export type GlossRow = {
  word: string;
  senseKey: string;
  gloss: string;
  examples: string[];
};

export type PoolScale = "sampled" | "full";

export type PoolManifest = {
  builtAt: string;
  scope: "sampled-2x2" | "full-vocabulary";
  /**
   * Which pool a cell was built from. Cells of different scale are NOT
   * comparable — fewer distractors is a strictly easier task — so this travels
   * into every cell's metadata and into every run's config, and the tooling
   * refuses to treat the two as one experiment.
   */
  scale: PoolScale;
  note: string;
  scoringNote: string;
  synsetNote: string;
  storageNote: string;
  distractorSeed: number;
  poolWords: number;
  glossRows: number;
  words: string[];
  targets: string[];
  glosses: GlossRow[];
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Mulberry32 — deterministic, so the pool is reproducible. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** lowercased lemma -> every sense naming it, across all parts of speech. */
function buildSenseMap(): Map<string, Sense[]> {
  const map = new Map<string, Sense[]>();
  for (const pos of POS_LIST) {
    for (const sense of readSenses(pos)) {
      if (!sense.gloss) continue;
      for (const word of sense.words) {
        const key = word.toLowerCase();
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(sense);
      }
    }
  }
  return map;
}

async function main(): Promise<void> {
  // The 20k sample was sized to fit inside Neon's 512 MB ceiling. That
  // constraint disappeared when the cells moved to local files, and a sample
  // actively works against the measurement: the failure under investigation is
  // morphological relatives outranking the true answer, and a 14% sample draws
  // roughly two of a word's twelve relatives — it strips out most of the
  // competition that produces the effect. A real gloss advantage could arrive
  // attenuated below the ~4-6 point detection threshold and read as "no
  // difference", which is the expensive error here.
  const full = process.argv.includes("--full");
  const distractorCount = full ? Infinity : Number(arg("--distractors") ?? 20000);
  const seed = Number(arg("--seed") ?? 20260818);

  console.log("Reading WordNet senses...");
  const senseMap = buildSenseMap();
  console.log(`  ${senseMap.size.toLocaleString()} distinct lemmas carry at least one gloss`);

  console.log("Reading VocabEmbedding...");
  const vocab = (
    await prisma.$queryRawUnsafe<{ word: string }[]>(`SELECT word FROM "VocabEmbedding"`)
  ).map((r) => r.word);
  console.log(`  ${vocab.length.toLocaleString()} rows`);

  // Only words that can appear in every cell.
  const eligible = vocab.filter((w) => senseMap.has(w.toLowerCase()));
  console.log(`  ${eligible.length.toLocaleString()} of them have a WordNet gloss (eligible)`);

  // ------------------------------------------------------------- targets
  const eligibleLower = new Map(eligible.map((w) => [w.toLowerCase(), w]));
  const wanted = AUTHORED.map((a) => a.target);
  const targets: string[] = [];
  const droppedTargets: string[] = [];
  for (const t of wanted) {
    const hit = eligibleLower.get(t.toLowerCase());
    if (hit) targets.push(hit);
    else droppedTargets.push(t);
  }
  console.log(`\n  ${targets.length} of ${wanted.length} draft targets are poolable`);
  console.log(`  ${droppedTargets.length} are not (absent from vocab, or no gloss):`);
  console.log(`    ${droppedTargets.join(", ")}`);

  // ---------------------------------------------------------- distractors
  const targetSet = new Set(targets);
  const candidates = eligible.filter((w) => !targetSet.has(w));
  const rand = rng(seed);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const distractors = Number.isFinite(distractorCount)
    ? candidates.slice(0, distractorCount)
    : candidates;

  // ---------------------------------------------------------------- layout
  // TARGETS MUST NOT OCCUPY PREDICTABLE ROWS. This list becomes the row order of
  // every cell, and a gloss cell's synset mates hold bit-identical vectors, so
  // whatever breaks their tie decides rank 1. An earlier version emitted
  // `[...targets, ...distractors]`, which put all 287 eval targets in the first
  // 685 rows; a tie-break that fell back to row order was then reading the
  // answer key, and it inflated every gloss cell's Recall@1 by up to 8.9 points
  // while leaving the tie-free lemma cells alone (METHODS.md §12).
  //
  // Shuffling the union with the same seeded PRNG keeps the pool exactly
  // reproducible while making row position carry no information about which
  // words are targets. `searchLocal` no longer breaks ties on row order either
  // — both fixes are held, so neither one silently becomes load-bearing.
  const words = [...targets, ...distractors];
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }

  const firstTargetRow = words.findIndex((w) => targetSet.has(w));
  const meanTargetRow =
    words.reduce((acc, w, i) => (targetSet.has(w) ? acc + i : acc), 0) / (targets.length || 1);
  console.log(
    `
  target layout: first target at row ${firstTargetRow}, mean target row ` +
      `${meanTargetRow.toFixed(0)} of ${words.length} ` +
      `(uniform would be ~${((words.length - 1) / 2).toFixed(0)})`
  );

  console.log(
    `\n  pool: ${targets.length} targets + ${distractors.length.toLocaleString()} distractors ` +
      `= ${words.length.toLocaleString()} words${full ? "  [FULL VOCABULARY]" : "  [SAMPLED]"}`
  );

  // -------------------------------------------------------------- glosses
  const glosses: GlossRow[] = [];
  let maxSenses = 0;
  let maxSensesWord = "";
  for (const word of words) {
    const senses = senseMap.get(word.toLowerCase()) ?? [];
    if (senses.length > maxSenses) {
      maxSenses = senses.length;
      maxSensesWord = word;
    }
    for (const sense of senses) {
      glosses.push({
        word,
        senseKey: `${sense.pos}:${sense.offset}`,
        gloss: sense.gloss,
        examples: sense.examples,
      });
    }
  }

  const withExamples = glosses.filter((g) => g.examples.length > 0).length;
  console.log(`\n  gloss rows: ${glosses.length.toLocaleString()}`);
  console.log(`    senses per word: mean ${(glosses.length / words.length).toFixed(2)}, max ${maxSenses} ("${maxSensesWord}")`);
  console.log(
    `    ${withExamples.toLocaleString()} (${((withExamples / glosses.length) * 100).toFixed(1)}%) carry example sentences`
  );

  const manifest: PoolManifest = {
    builtAt: new Date().toISOString(),
    scope: full ? "full-vocabulary" : "sampled-2x2",
    scale: full ? "full" : "sampled",
    note: full
      ? "FULL-VOCABULARY pool for the 2x2 representation experiment: every word in " +
        "VocabEmbedding ∩ (has a WordNet gloss). Matched by construction across all " +
        "cells, so no cell can win on coverage. Still NOT the production build — that " +
        "would use the full WordNet lemma set and would also repair the ~5% coverage " +
        "gap this pool inherits from VocabEmbedding."
      : "SAMPLED matched pool for the 2x2 representation experiment. Words are " +
        "restricted to VocabEmbedding ∩ (has a WordNet gloss) so no cell can win " +
        "on coverage. Absolute recall is NOT comparable to a full-scale cell — fewer " +
        "distractors is a strictly easier task. NOT the production build either.",
    synsetNote:
      "A per-synset cell (see scripts/build-synset-cell.ts) stores one row per " +
      "synset and expands to member words at query time, so ONE retrieved synset " +
      "can consume several top-10 slots — a 24-member synset at rank 1 fills the " +
      "whole top 10 by itself. Its scoring surface therefore differs from a " +
      "per-sense gloss cell's. Report it SEPARATELY; never substitute it for " +
      "eval_gloss_base in the 2x2.",
    storageNote:
      "Synset-mates hold bit-identical vectors, so the gloss index deduplicates by " +
      "~44%. As a Postgres index the per-synset form is ~59 MB at halfvec(256) " +
      "against ~105 MB per-sense (vector payload only, index overhead extra) — which " +
      "is what makes running it alongside VocabEmbedding feasible inside the 512 MB " +
      "ceiling.",
    scoringNote: full
      ? `Scoring a full-scale gloss cell is a brute-force scan of ${glosses.length.toLocaleString()} ` +
        `rows x 384 dims — about ${((glosses.length * 384) / 1e6).toFixed(0)}M multiply-adds per query, ` +
        `so expect roughly 10 minutes for a ~300-query set rather than 1. That is the ` +
        `search working, not a hang.`
      : "Scoring a sampled cell takes about a minute for a ~300-query set.",
    distractorSeed: seed,
    poolWords: words.length,
    glossRows: glosses.length,
    words,
    targets,
    glosses,
  };

  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest), "utf8");
  console.log(`\n  wrote ${path.relative(process.cwd(), MANIFEST)} (${(fs.statSync(MANIFEST).size / 1e6).toFixed(1)} MB)`);

  console.log(`\n  Embedding budget:`);
  console.log(`    lemma cells: ${words.length.toLocaleString()} texts x 2 models`);
  console.log(`    gloss cells: ${glosses.length.toLocaleString()} texts x 4 models/variants`);
  const totalTexts = words.length * 2 + glosses.length * 4;
  console.log(
    `    all six:     ${totalTexts.toLocaleString()} texts ≈ ${(totalTexts / 75 / 3600).toFixed(1)}h at ~75/s`
  );
  console.log(
    `    disk:        ${(((words.length * 2 + glosses.length * 4) * 384 * 4) / 1e9).toFixed(2)} GB of vectors`
  );
  console.log(`\n  ${manifest.scoringNote}`);
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
