/**
 * Write out the hand-written question set for review.
 *
 * This checks and annotates; it does not write questions. Every row is tested
 * against the rules before it is written, and nothing is emitted if one fails:
 * the question must not contain its own answer, must be at least three words,
 * and no answer may appear twice.
 *
 * Whether a word is findable, how common it is and how long the question is are
 * all looked up here rather than typed by hand, so they cannot drift.
 *
 * The "acceptable" column is left empty for the reviewer to fill in with other
 * answers that should count as correct. That is what makes the more forgiving
 * score possible.
 *
 *   npx tsx scripts/build-draft-tsv.ts
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { bandOf, FREQ_BANDS, loadZipf, type FreqBand } from "./lib/freq";
import { contentTokens, echoesQuery } from "./lib/probes";
import { AUTHORED, type AuthoredPair } from "./data/authored-v1";

loadEnv();

const prisma = new PrismaClient();
const OUT_PATH = path.resolve(process.cwd(), "eval/sets/v1-draft.tsv");

const COLUMNS = [
  "target",
  "query",
  "sense_hint",
  "zipf",
  "freq_band",
  "token_count",
  "style",
  "lexical_overlap",
  "reachable",
  "acceptable",
] as const;

/**
 * How much of the answer the question already gives away: nothing, a shared word
 * stem ("open metal cans" / "can opener"), or one word of a multi-word answer
 * ("the round hard black hat" / "bowler hat").
 *
 * None of these are thrown out. A person asking about a bowler hat says "hat",
 * and scrubbing that would measure a way of asking that nobody uses. The
 * giveaway is partial anyway — "hat" narrows things down but does not supply
 * "bowler". Labelling them lets scores be reported with and without.
 */
export type LexicalOverlap = "none" | "stem_shared" | "head_noun";

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/** A real violation: the question contains its answer outright. */
// One word of a multi-word answer is not a violation; it gets labelled instead.
function queryContainsTarget(query: string, target: string): boolean {
    // One test covers both: for a one-word answer, the phrase is the word.
  return normalise(query).includes(` ${normalise(target).trim()} `);
}

function classifyOverlap(query: string, target: string): LexicalOverlap {
  const q = normalise(query);
  const t = normalise(target).trim();

  if (t.includes(" ")) {
    for (const token of t.split(" ")) {
      if (token.length >= 3 && q.includes(` ${token} `)) return "head_noun";
    }
  }
  return echoesQuery(target, contentTokens(query)) ? "stem_shared" : "none";
}

type Violation = { target: string; reason: string };

async function main(): Promise<void> {
  const zipf = loadZipf();

  // --------------------------------------------------------------- validate
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const pair of AUTHORED) {
    const key = pair.target.toLowerCase();
    if (seen.has(key)) violations.push({ target: pair.target, reason: "duplicate target" });
    seen.add(key);

    if (wordCount(pair.query) < 3) {
      violations.push({ target: pair.target, reason: `query is only ${wordCount(pair.query)} words` });
    }
    if (queryContainsTarget(pair.query, pair.target)) {
      violations.push({ target: pair.target, reason: "query contains the target" });
    }
    if (wordCount(pair.hint) > 1) {
      violations.push({ target: pair.target, reason: `sense hint is ${wordCount(pair.hint)} words, max 1` });
    }
  }

  if (violations.length) {
    console.error(`REFUSING TO EMIT — ${violations.length} rule violation(s):\n`);
    for (const v of violations) console.error(`  ${v.target.padEnd(24)} ${v.reason}`);
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------------------------- annotate
  const targets = AUTHORED.map((p) => p.target);
  const present = new Set(
    (
      await prisma.$queryRawUnsafe<{ word: string }[]>(
        `SELECT lower(word) AS word FROM "VocabEmbedding" WHERE lower(word) = ANY($1::text[])`,
        targets.map((t) => t.toLowerCase())
      )
    ).map((r) => r.word)
  );

  type Row = AuthoredPair & {
    zipf: number | undefined;
    band: FreqBand;
    tokens: "single" | "multi";
    reachable: boolean;
    overlap: LexicalOverlap;
  };

  const rows: Row[] = AUTHORED.map((pair) => {
    const z = zipf.get(pair.target.toLowerCase());
    return {
      ...pair,
            // The raw frequency is what's stored; the band is worked out from it, so
            // the boundaries can be redrawn later without rebuilding the set.
      zipf: z,
      band: bandOf(z),
      tokens: /[ _-]/.test(pair.target) ? "multi" : "single",
      reachable: present.has(pair.target.toLowerCase()),
      overlap: classifyOverlap(pair.query, pair.target),
    };
  });

  // -------------------------------------------------- surprises worth review
  const unexpectedlyMissing = rows.filter((r) => !r.reachable && !r.expectUnreachable);
  const unexpectedlyPresent = rows.filter((r) => r.reachable && r.expectUnreachable);

  // ------------------------------------------------------------------ emit
  const bandRank = new Map(FREQ_BANDS.map((b, i) => [b, i]));
  rows.sort((a, b) => {
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    const band = bandRank.get(a.band)! - bandRank.get(b.band)!;
    if (band !== 0) return band;
    if (a.style !== b.style) return a.style < b.style ? -1 : 1;
    return a.target < b.target ? -1 : 1;
  });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const lines = [
    "# Reverse-dictionary evaluation set v1 — DRAFT, authored slice.",
    "#",
    "# PROVENANCE. Every query was written blind: from the target word and a",
    "# one-word sense hint only. No WordNet gloss, no Word.definition row and no",
    "# dictionary of any kind was consulted while writing. This is what keeps the",
    "# set usable against a model that was fine-tuned on WordNet glosses.",
    "#",
    "# LIMITATION — state this wherever the set is cited. Every query was authored",
    "# by a single writer in a single session. The set is therefore single-register",
    "# even though it is blind, and it is NOT a sample of real user queries. No",
    "# query text has ever been logged by this product (see the Lookup table), so",
    "# no such sample exists to draw from.",
    "#",
    "# zipf is the stored truth; freq_band is a derived convenience and its",
    "# boundaries may be redrawn at analysis time. Source: OpenSubtitles 2018,",
    "# which under-weights literary and technical vocabulary — 'rare' by this",
    "# measure is not necessarily rare in writing.",
    "#",
    "# lexical_overlap: none | stem_shared | head_noun. Overlap rows are kept on",
    "# purpose; the harness reports recall both including and excluding them.",
    "#",
    "# reachable=false rows measure vocabulary coverage and are excluded from",
    "# headline recall.",
    "#",
    "# acceptable: comma-separated alternate answers that should also count.",
    COLUMNS.join("\t"),
  ];
  for (const r of rows) {
    lines.push(
      [
        r.target,
        r.query,
        r.hint,
        r.zipf === undefined ? "" : r.zipf.toFixed(3),
        r.band,
        r.tokens,
        r.style,
        r.overlap,
        String(r.reachable),
        "", // acceptable — for the reviewer to populate
      ].join("\t")
    );
  }
  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");

  // --------------------------------------------------------------- report
  console.log(`Wrote ${path.relative(process.cwd(), OUT_PATH)} — ${rows.length} rows\n`);

  const reachable = rows.filter((r) => r.reachable);
  console.log(`  reachable   ${reachable.length}   (headline recall is computed on these)`);
  console.log(`  unreachable ${rows.length - reachable.length}   (coverage defect, excluded from headline)\n`);

  const tally = (key: (r: Row) => string, label: string, over: Row[] = reachable) => {
    const counts = new Map<string, number>();
    for (const r of over) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
    console.log(`  by ${label}:`);
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(14)} ${String(n).padStart(4)}`);
    }
    console.log("");
  };

  tally((r) => r.band, "frequency band");
  tally((r) => r.style, "style");
  tally((r) => r.tokens, "token count");

  const lengths = reachable.map((r) => wordCount(r.query)).sort((a, b) => a - b);
  console.log(
    `  query length (words): min ${lengths[0]}  p50 ${lengths[Math.floor(lengths.length / 2)]}  ` +
      `max ${lengths[lengths.length - 1]}\n`
  );

  tally((r) => r.overlap, "lexical overlap (all rows)", rows);

  const overlapping = rows.filter((r) => r.overlap !== "none");
  console.log(`  the ${overlapping.length} overlap rows (kept on purpose, reported separately):`);
  for (const r of overlapping) {
    console.log(`    ${r.overlap.padEnd(12)} ${r.target.padEnd(20)} ${r.query}`);
  }

  if (unexpectedlyMissing.length) {
    console.log(`\n  NOT IN VOCAB but expected to be (re-label or replace):`);
    for (const r of unexpectedlyMissing) console.log(`    ${r.target}`);
  }
  if (unexpectedlyPresent.length) {
    console.log(`\n  IN VOCAB but expected missing (will count toward headline recall):`);
    for (const r of unexpectedlyPresent) console.log(`    ${r.target}`);
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
