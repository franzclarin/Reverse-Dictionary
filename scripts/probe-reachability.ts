/**
 * Are the frozen set's `reachable` flags still true? (RD-17, acceptance criterion 9)
 *
 * `meta.reachable` was computed once, against `VocabEmbedding`, before the RD-02
 * cutover moved search to `GlossEmbedding`. It is stored truth inside a FROZEN
 * file, so it does not update itself and must not be edited in place — a new
 * version means a new filename, and RD-05 owns that job. What it can do is be
 * RECOMPUTED AT ANALYSIS TIME, which is this script.
 *
 * WHY THE STALE FLAGS ARE LOAD-BEARING RATHER THAN COSMETIC. The headline slice
 * is `source === "authored" && meta.reachable !== false`, so every recall figure
 * this project has recorded is scored over whatever that flag said. Two rows are
 * flagged unreachable and are answerable today (RD-02 repaired them as a side
 * effect nobody was looking for), which means the 287-row denominator is two
 * rows smaller than the set can actually support.
 *
 * KEEPING IT AT 287 IS THE RIGHT CALL, and this script exists to make that a
 * decision rather than an oversight. A denominator that moves when the index
 * moves cannot compare two indexes: RD-17's own arithmetic warning is that a
 * strictly better app scores worse when coverage grows the denominator faster
 * than the numerator. Holding the flag fixed is what makes the regression test
 * a regression test. The coverage slice carries the capability separately.
 *
 * Read-only against both tables and against the set.
 *
 *   npx tsx scripts/probe-reachability.ts
 *   npx tsx scripts/probe-reachability.ts --set eval/sets/v1.jsonl
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { GLOSS_INDEX } from "../lib/glossSearch";

loadEnv();

const DEFAULT_SET = "eval/sets/v1.jsonl";

type Row = {
  id: string;
  target: string;
  source: string;
  meta: { reachable?: boolean; acceptable?: string[] };
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const setFile = arg("--set") ?? DEFAULT_SET;
  const full = path.resolve(process.cwd(), setFile);
  const bytes = fs.readFileSync(full);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const rows = bytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);

  console.log(`\nRD-17 · reachability recompute\n`);
  console.log(`  set     ${setFile}`);
  console.log(`  sha256  ${sha}`);
  console.log(`  rows    ${rows.length}\n`);

  const prisma = new PrismaClient();
  try {
    const glossRows = await prisma.$queryRawUnsafe<{ w: string }[]>(
      `SELECT DISTINCT lower(unnest(lemmas)) AS w FROM "${GLOSS_INDEX}"`
    );
    const gloss = new Set(glossRows.map((r) => r.w));
    const lemmaRows = await prisma.$queryRawUnsafe<{ w: string }[]>(
      `SELECT DISTINCT lower(word) AS w FROM "VocabEmbedding"`
    );
    const lemma = new Set(lemmaRows.map((r) => r.w));

    console.log(
      `  ${GLOSS_INDEX} answers with ${gloss.size.toLocaleString()} lemmas; ` +
        `VocabEmbedding holds ${lemma.size.toLocaleString()}\n`
    );

    // A row is "reachable" if the target OR any accepted synonym is answerable —
    // the same disjunction lenient R@1 scores against, so the flag means the same
    // thing the metric does.
    const answerable = (r: Row): boolean =>
      [r.target, ...(r.meta.acceptable ?? [])].some((w) => gloss.has(w.toLowerCase()));

    const staleFalse = rows.filter((r) => r.meta.reachable === false && answerable(r));
    const staleTrue = rows.filter((r) => r.meta.reachable !== false && !answerable(r));

    console.log(`  flagged unreachable but ANSWERABLE today: ${staleFalse.length}`);
    for (const r of staleFalse) console.log(`    ${r.id}  ${r.target}`);
    console.log(`\n  flagged reachable but NOT answerable today: ${staleTrue.length}`);
    for (const r of staleTrue.slice(0, 20)) console.log(`    ${r.id}  ${r.target}`);
    if (staleTrue.length > 20) console.log(`    ... and ${staleTrue.length - 20} more`);

    const headline = rows.filter(
      (r) => r.source === "authored" && r.meta.reachable !== false
    );
    console.log(
      `\n  headline slice as scored: ${headline.length} rows` +
        `   as the live index would compute it: ${headline.length + staleFalse.filter((r) => r.source === "authored").length - staleTrue.filter((r) => r.source === "authored").length}`
    );
    console.log(
      `\n  The set is FROZEN and this changes nothing in it. The denominator stays ${headline.length}\n` +
        `  on purpose: a denominator that moves when the index moves cannot compare two\n` +
        `  indexes. Any correction lands as a NEW FILENAME — RD-05 owns that.\n`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
