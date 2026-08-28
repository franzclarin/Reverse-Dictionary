/**
 * RD-17 — where did the extra echo come from?
 *
 * Echo rate is a primary metric precisely so a recall change cannot be read
 * without it. The expansion left lenient R@1 flat (−0.3pp, p = 1.0) and raised
 * echo 14.5% -> 17.5%, and "recall did not move but echo did" is exactly the
 * pattern that needs a mechanism rather than a shrug.
 *
 * Two things this separates, which the headline number cannot:
 *
 *   1. Is the extra echo coming from the ADDED words, or did the WordNet words
 *      start echoing more? Only the first is explicable by the expansion; the
 *      second would mean something changed about rows that were copied verbatim,
 *      which is impossible and would indicate a build fault.
 *   2. Is echo displacing correct answers, or filling slots that were wrong
 *      anyway? Echo matters because it crowds out the target — echo in the tail
 *      of a list that never had the answer costs nothing.
 *
 * Reads committed run JSON only. No model, no database.
 *
 *   npx tsx scripts/probe-supplement-echo.ts
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { contentTokens, echoesQuery } from "./lib/probes";
import { GLOSS_INDEX } from "../lib/glossSearch";

loadEnv();

const CONTROL = "eval/runs/rd17_control.json";
const ARM = "eval/runs/rd17_wikt_all.json";

type Result = {
  id: string;
  query: string;
  target: string;
  source: string;
  results: string[];
  rank: number | null;
  lenientRank: number | null;
  meta: { reachable?: boolean };
};

function load(file: string): Result[] {
  return (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), "utf8")) as {
    results: Result[];
  }).results;
}

function headline(rows: Result[]): Result[] {
  return rows.filter((r) => r.source === "authored" && r.meta.reachable !== false);
}

async function main(): Promise<void> {
  const control = headline(load(CONTROL));
  const arm = headline(load(ARM));
  const byId = new Map(control.map((r) => [r.id, r]));

  const prisma = new PrismaClient();
  let wordnet: Set<string>;
  try {
    const rows = await prisma.$queryRawUnsafe<{ w: string }[]>(
      `SELECT DISTINCT lower(unnest(lemmas)) AS w FROM "${GLOSS_INDEX}"`
    );
    wordnet = new Set(rows.map((r) => r.w));
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\nRD-17 · echo composition   n=${arm.length} authored reachable\n`);

  let slots = 0;
  let added = 0;
  let echoSlots = 0;
  let echoFromAdded = 0;
  let echoFromWordnet = 0;

  for (const r of arm) {
    const tokens = contentTokens(r.query);
    for (const word of r.results) {
      slots++;
      const isNew = !wordnet.has(word.toLowerCase());
      if (isNew) added++;
      if (echoesQuery(word, tokens)) {
        echoSlots++;
        if (isNew) echoFromAdded++;
        else echoFromWordnet++;
      }
    }
  }

  console.log(`  top-10 slots filled            ${slots.toLocaleString()}`);
  console.log(
    `  filled by an ADDED word        ${added.toLocaleString()}  (${((100 * added) / slots).toFixed(1)}%)`
  );
  console.log(
    `  echoing slots                  ${echoSlots.toLocaleString()}  (${((100 * echoSlots) / slots).toFixed(1)}%)`
  );
  console.log(
    `    ... from an added word       ${echoFromAdded.toLocaleString()}  ` +
      `(${((100 * echoFromAdded) / Math.max(echoSlots, 1)).toFixed(1)}% of the echo)`
  );
  console.log(
    `    ... from a WordNet word      ${echoFromWordnet.toLocaleString()}  ` +
      `(${((100 * echoFromWordnet) / Math.max(echoSlots, 1)).toFixed(1)}% of the echo)`
  );

  // Echo per-word among added vs WordNet rows: is the new vocabulary *more*
  // echo-prone, or simply more numerous?
  const echoRateAdded = added ? (100 * echoFromAdded) / added : 0;
  const echoRateWordnet = slots - added ? (100 * echoFromWordnet) / (slots - added) : 0;
  console.log(
    `\n  echo rate WITHIN added words   ${echoRateAdded.toFixed(1)}%` +
      `      within WordNet words  ${echoRateWordnet.toFixed(1)}%`
  );

  // Does the extra echo cost anything? Split the queries by whether the answer
  // was found, and by whether the arm moved the rank.
  const worse = arm.filter((r) => {
    const c = byId.get(r.id);
    return c && c.lenientRank === 1 && r.lenientRank !== 1;
  });
  const better = arm.filter((r) => {
    const c = byId.get(r.id);
    return c && c.lenientRank !== 1 && r.lenientRank === 1;
  });
  const displaced = worse.filter((r) => {
    const tokens = contentTokens(r.query);
    return Boolean(r.results[0]) && echoesQuery(r.results[0], tokens);
  });

  console.log(
    `\n  rank-1 lost      ${worse.length}   of which the new top result ECHOES the query: ${displaced.length}`
  );
  console.log(`  rank-1 gained    ${better.length}`);
  console.log(
    `\n  Read: echo that fills slots a wrong answer already held costs nothing. Echo that\n` +
      `  takes rank 1 from the target is the failure the metric exists to catch, and the\n` +
      `  count above is how often it actually happened.\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
