/**
 * How often do the old and new searches pick the same top answer?
 *
 * Read this before treating it like the scoring harness's comparison. That one
 * runs against a set of questions with known-correct answers, so it can say
 * which system is more often right. Live traffic carries no correct answer — by
 * design, since the questions themselves are never stored. So this can only
 * report how often the two agree, never which one is correct.
 *
 * Do not add a significance test here. There is no valid pair of numbers to feed
 * one, and doing it anyway would silently misuse the test. The proper comparison
 * has already been run against the labelled question set; this is a live-traffic
 * sanity check against that result, not a replacement for it.
 *
 *   npx tsx scripts/shadow-compare.ts --since 2026-09-01
 */
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";

loadEnv();

const prisma = new PrismaClient();

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const since = arg("--since");
  const sinceDate = since ? new Date(since) : undefined;
  if (since && Number.isNaN(sinceDate?.getTime())) {
    console.error(`--since ${since} is not a valid date`);
    process.exitCode = 1;
    return;
  }

  const rows = await prisma.shadowLookup.findMany({
    where: sinceDate ? { createdAt: { gte: sinceDate } } : undefined,
    orderBy: { createdAt: "asc" },
  });

  if (rows.length === 0) {
    console.log(
      "No ShadowLookup rows found. Either the route instrumentation isn't deployed/enabled yet, " +
        "or --since excludes everything that exists. See MIGRATION_AUDIT.md for status."
    );
    return;
  }

  const agreements = rows.filter((r) => r.agree).length;
  const disagreements = rows.length - agreements;
  const agreementRate = (agreements / rows.length) * 100;

  console.log(`n=${rows.length}`);
  console.log(`  agree      ${agreements.toLocaleString()} (${agreementRate.toFixed(1)}%)`);
  console.log(`  disagree   ${disagreements.toLocaleString()} (${(100 - agreementRate).toFixed(1)}%)`);
  console.log(
    `\nThis is agreement rate only, not an accuracy comparison — see this file's header ` +
      `comment for why a McNemar test isn't valid on shadow data. Compare qualitatively against ` +
      `the eval set's own result (cell_lemma_ft vs cell_gloss_ft_synset, p < 0.0001) as a prior, ` +
      `not as a like-for-like statistic.`
  );

  console.log(`\nFirst ${Math.min(10, disagreements)} disagreements (for manual review):`);
  for (const r of rows.filter((r) => !r.agree).slice(0, 10)) {
    console.log(
      `  ${r.createdAt.toISOString()}  old="${r.oldTop1}" (${r.oldSimilarity.toFixed(3)})  ` +
        `new="${r.newTop1}" (${r.newSimilarity.toFixed(3)})`
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
