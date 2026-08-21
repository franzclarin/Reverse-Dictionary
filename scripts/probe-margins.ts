/**
 * Phase A3 — do the echo neighbours actually outscore the truth?
 *
 * Phase A established that 34.4% of top-10 results are morphological relatives
 * of the query's own words, and Phase A2 established that the correct answer
 * sits at ~0.53 cosine from a natural description of itself. What neither
 * measured is the *margin*: are the echoes far above the target, or just
 * barely ahead of it?
 *
 * Two worlds:
 *   - echoes ~0.75 vs target ~0.53  -> structural. Only a representation
 *     change (Phase E) closes a gap that size.
 *   - echoes ~0.56 vs target ~0.53  -> ordering. Cheap interventions (a
 *     reranker, an echo penalty, score calibration) become live.
 *
 * Read-only.  npx tsx scripts/probe-margins.ts
 */
import { PrismaClient } from "@prisma/client";
import { embed } from "@/lib/embedder";
import { search } from "./lib/retrieval";
import { loadEnv } from "./lib/env";
import { PROBE_QUERIES, contentTokens, echoesQuery } from "./lib/probes";

loadEnv();

const prisma = new PrismaClient();

function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : NaN;
}

function fmt(n: number): string {
  return Number.isNaN(n) ? "   n/a" : n.toFixed(4);
}

/** Cosine of the query against a lemma's stored vector, via pgvector. */
async function similarityTo(vectorLiteral: string, word: string): Promise<number | null> {
  const rows = await prisma.$queryRawUnsafe<{ similarity: number }[]>(
    `SELECT 1 - (embedding <=> $1::vector) AS similarity
       FROM "VocabEmbedding" WHERE word = $2 LIMIT 1`,
    vectorLiteral,
    word
  );
  return rows.length ? rows[0].similarity : null;
}

async function main(): Promise<void> {
  console.log("Warming the embedder...\n");
  await embed("warm up");

  const targetSims: number[] = [];
  const echoSims: number[] = [];
  const nonEchoSims: number[] = [];
  const top1Sims: number[] = [];
  const margins: number[] = [];
  let rankedWithin10 = 0;
  let unreachable = 0;
  /**
   * Targets that outscore results the index *did* return, yet were not
   * returned themselves. The index surfaced strictly worse candidates — an
   * approximate-recall failure, not a ranking failure. `--exact` in Phase D
   * settles the exact size; this counts the cases.
   */
  const indexMisses: { answer: string; sim: number; beaten: number }[] = [];
  const rankingFailures: string[] = [];

  for (const { query, answer } of PROBE_QUERIES) {
    const vector = await embed(query);
    const literal = `[${vector.join(",")}]`;
    const rows = await search(prisma, vector, { k: 10 });
    const tokens = contentTokens(query);

    const targetSim = await similarityTo(literal, answer);
    top1Sims.push(rows[0].similarity);

    console.log(`\n${"=".repeat(78)}`);
    console.log(`Q: ${query}`);
    if (targetSim === null) {
      unreachable++;
      console.log(`   target "${answer}": NOT IN VOCAB — no stored vector`);
    } else {
      targetSims.push(targetSim);
      const margin = rows[0].similarity - targetSim;
      margins.push(margin);
      const beating = rows.filter((r) => r.similarity > targetSim).length;
      const rankNeeded = beating + 1;
      const returned = rows.some((r) => r.word.toLowerCase() === answer.toLowerCase());
      if (returned) {
        rankedWithin10++;
      } else if (rankNeeded <= 10) {
        indexMisses.push({ answer, sim: targetSim, beaten: rows.length - beating });
      } else {
        rankingFailures.push(answer);
      }
      console.log(
        `   target "${answer}": ${targetSim.toFixed(4)}   ` +
          `top1 ${rows[0].similarity.toFixed(4)}   margin ${margin >= 0 ? "+" : ""}${margin.toFixed(4)}   ` +
          `would need rank ${rankNeeded}`
      );
    }

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const isEcho = echoesQuery(r.word, tokens);
      (isEcho ? echoSims : nonEchoSims).push(r.similarity);
      const beatsTarget = targetSim !== null && r.similarity > targetSim;
      console.log(
        `     ${String(i + 1).padStart(2)}. ${r.similarity.toFixed(4)} ` +
          `${isEcho ? "ECHO" : "    "} ${beatsTarget ? ">" : " "} ${r.word}`
      );
    }
  }

  const mTarget = mean(targetSims);
  const mEcho = mean(echoSims);
  const mNonEcho = mean(nonEchoSims);

  console.log(`\n${"=".repeat(78)}`);
  console.log("AGGREGATE");
  console.log("=".repeat(78));
  console.log(`  intended target (${targetSims.length} reachable)        ${fmt(mTarget)}`);
  console.log(`  returned results classified ECHO (${echoSims.length})     ${fmt(mEcho)}`);
  console.log(`  returned results NOT echo (${nonEchoSims.length})          ${fmt(mNonEcho)}`);
  console.log(`  top-1 result (${top1Sims.length})                        ${fmt(mean(top1Sims))}`);
  console.log(`\n  GAP  echo - target      ${fmt(mEcho - mTarget)}`);
  console.log(`  GAP  non-echo - target  ${fmt(mNonEcho - mTarget)}`);
  console.log(`  GAP  top1 - target      ${fmt(mean(margins))}   (mean per-query margin)`);
  console.log(
    `\n  ${rankedWithin10}/${targetSims.length} reachable targets appear in top-10; ` +
      `${unreachable} targets unreachable`
  );

  console.log(`\n${"-".repeat(78)}`);
  console.log("Decomposing the misses");
  console.log("-".repeat(78));
  console.log(
    `  approximate-index misses (${indexMisses.length}): target outscores results that WERE`
  );
  console.log(`  returned, but the IVFFlat scan never surfaced it.`);
  for (const m of indexMisses) {
    console.log(
      `    ${m.answer.padEnd(18)} ${m.sim.toFixed(4)}  outscores ${m.beaten}/10 of what came back`
    );
  }
  console.log(`\n  true ranking failures (${rankingFailures.length}): outscored by everything returned.`);
  console.log(`    ${rankingFailures.join(", ")}`);

  const gap = mEcho - mTarget;
  console.log("\nVERDICT:");
  if (gap > 0.12) {
    console.log("  STRUCTURAL. Echo neighbours sit far above the target, not just ahead");
    console.log("  of it. No reranker over these lists can recover the answer, because");
    console.log("  the answer is not in them. Phase E (representation change) is the");
    console.log("  only intervention that addresses a gap this size.");
  } else if (gap > 0.03) {
    console.log("  MIXED. A real gap, but not a chasm. Phase E is still the main lever;");
    console.log("  an echo penalty at query time may be worth measuring alongside it.");
  } else {
    console.log("  ORDERING. Echoes only just outscore the target. Cheap interventions");
    console.log("  (echo penalty, reranking, score calibration) are live and should be");
    console.log("  measured before spending CPU on index builds.");
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
