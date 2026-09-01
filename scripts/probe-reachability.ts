/**
 * Are the question set's "is this word findable" flags still true?
 *
 * They were worked out once, against the old index, before search moved to the
 * new one. They live inside a frozen file, so they do not update themselves and
 * must not be edited in place — a new version means a new filename. What they
 * can be is recomputed at analysis time, which is what this does.
 *
 * This matters rather than being cosmetic: every score this project has recorded
 * counts only the questions those flags call findable. Two are marked unfindable
 * and are answerable today, so the total is two smaller than it could be.
 *
 * Keeping it as it is remains the right call, and this script exists to make
 * that a decision rather than an oversight. A total that moves when the index
 * moves cannot compare two indexes — a strictly better app can score worse when
 * coverage grows the total faster than the successes. Holding it fixed is what
 * makes the regression test a regression test; new ability is reported separately.
 *
 * Read-only.
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

        // Findable means the answer or any accepted synonym is findable — the same
        // either/or the forgiving score uses, so the flag means what the score does.
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
