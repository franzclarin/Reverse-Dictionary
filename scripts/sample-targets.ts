/**
 * Sample candidate eval targets, stratified by frequency band and token count.
 *
 * This produces a *candidate pool*, not the eval set. Random lemmas from
 * WordNet include a great deal no user would ever grope for ("ictodosaur",
 * "canulization"), so the pool is curated by hand afterwards — a query only
 * belongs in the benchmark if a real person could plausibly be reaching for
 * that word.
 *
 * Deliberately emits the word and nothing else: no gloss, no definition, no
 * part of speech. The authoring protocol requires drafting blind, and a
 * sampler that printed glosses would break it before authoring started.
 *
 *   npx tsx scripts/sample-targets.ts > eval/audit/target-candidates.txt
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { bandOf, FREQ_BANDS, loadZipf, type FreqBand } from "./lib/freq";

loadEnv();

const prisma = new PrismaClient();
const PER_CELL = 200;

/** Mulberry32 — deterministic, so the candidate pool is reproducible. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main(): Promise<void> {
  const zipf = loadZipf();

  // Lowercase entries only (the answerable pool), excluding the 93 words that
  // back the gloss_tripwire slice so the two slices stay independent.
  const rows = await prisma.$queryRawUnsafe<{ word: string }[]>(
    `SELECT v.word
       FROM "VocabEmbedding" v
      WHERE v.word ~ '^[a-z]'
        AND NOT EXISTS (
          SELECT 1 FROM "Word" w
           WHERE lower(w.word) = lower(v.word) AND w.definition <> ''
        )`
  );

  const cells = new Map<string, string[]>();
  for (const { word } of rows) {
    const band: FreqBand = bandOf(zipf.get(word));
    const tokens = /[ _]/.test(word) ? "multi" : "single";
    const key = `${band}/${tokens}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push(word);
  }

  const rand = rng(20260818);
  const bands: FreqBand[] = FREQ_BANDS;

  const out: string[] = [
    "Candidate targets for the authored eval slice.",
    "Stratified by frequency band x token count. Seed 20260818.",
    "Words only — no glosses, by design (authoring is blind).",
    "",
  ];

  for (const band of bands) {
    for (const tokens of ["single", "multi"]) {
      const key = `${band}/${tokens}`;
      const pool = cells.get(key) ?? [];
      const picked = shuffle(pool, rand).slice(0, PER_CELL);
      out.push(
        `${"=".repeat(70)}`,
        `${key}   (pool ${pool.length.toLocaleString()}, showing ${picked.length})`,
        `${"=".repeat(70)}`
      );
      for (let i = 0; i < picked.length; i += 6) {
        out.push("  " + picked.slice(i, i + 6).join(" | "));
      }
      out.push("");
    }
  }

  const outPath = path.resolve(process.cwd(), "eval/audit/target-candidates.txt");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out.join("\n"), "utf8");

  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
  for (const band of bands) {
    for (const tokens of ["single", "multi"]) {
      const key = `${band}/${tokens}`;
      console.log(`  ${key.padEnd(22)} pool ${(cells.get(key) ?? []).length.toLocaleString()}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
