/**
 * Report agreement rate between VocabEmbedding (old, lemma index) and
 * GlossEmbedding (new, synset-gloss index) from ShadowLookup rows — the data
 * CLAUDE.md's "Next steps" section says the cutover decision is gated on.
 *
 * IMPORTANT — read before treating this like `eval.ts --compare`:
 * `eval.ts --compare` runs a paired McNemar test on rank-1 DISAGREEMENTS
 * against a LABELLED set (eval/sets/v1.jsonl — every row has a known-correct
 * target), so it can say which system is more often *right*. Shadow-logged
 * production traffic has no such label (CLAUDE.md: "No query text has ever
 * been logged" — there is no ground truth to score against, by design). So
 * this script can only report how often the two systems' top-1 answers
 * AGREE, never which one is correct. mcnemar() from scripts/lib/metrics.ts
 * is imported and available, but there is no valid (b, c) pair to feed it
 * here — it is NOT called by this script. Don't add a call that treats
 * "old disagreed, new agreed [with itself]" as a McNemar cell; that would
 * silently misuse the test. The realistic use of the eval set's own McNemar
 * result (cell_lemma_ft vs cell_gloss_ft_synset, p < 0.0001, already computed
 * and reported in CLAUDE.md) is as the PRIOR — this script is a live-traffic
 * sanity/drift check against that prior, not a replacement for it.
 *
 * Runnable for real as of RD-02: route instrumentation is reviewed, enabled
 * (SHADOW_LOOKUP_ENABLED), and deployed. Rows accumulate as sampled
 * production traffic arrives — see MIGRATION_AUDIT.md for the rollout log.
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
