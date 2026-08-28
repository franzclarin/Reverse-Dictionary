/**
 * RD-21 — when the target is retrieved but not first, HOW FAR below first is it?
 *
 * WHY THIS IS NOT `probe-margins.ts`. That one is Phase A3: 25 hand-picked
 * queries, top 10, against `VocabEmbedding`, asking whether *echo* neighbours
 * outscore the truth. It answered its question and its numbers (+0.134 echo,
 * +0.094 non-echo) are still quoted in CLAUDE.md — but they describe the LEMMA
 * index, which two cutovers have since replaced. This runs the whole frozen set
 * down the live serving path at depth 100 and asks a different question.
 *
 * WHAT IT IS FOR. Every ticket since RD-12 has cited a large "headroom": the
 * target is inside the top 100 far more often than it is at rank 1, so a perfect
 * reranker over that shortlist would claim the difference. That framing is
 * arithmetically true and it hides the thing that decides whether any reranker
 * can: a shortlist where the target sits 0.001 below rank 1 and one where it
 * sits 0.15 below produce the SAME headroom figure and are not the same problem.
 *
 *   near-ties          -> the ranking is uninformative and a better scorer,
 *                         a calibration, or an echo penalty is live.
 *   confident margins  -> the encoder is not undecided, it is wrong, and
 *                         reordering its scores cannot fix what produced them.
 *
 * Read-only, and it uses the SERVING path (`searchGlossSynsets` + `expandSynsets`
 * from `lib/glossSearch.ts`) rather than a reimplementation — the margins have to
 * be the margins users get, or the number describes a lookalike.
 *
 * Ranks are LENIENT (target plus `acceptable[]`), matching the metric METHODS
 * §9a resolves on. Scoring strict here would count a synonym tie as a miss and
 * inflate the headroom with queries that are already answered.
 *
 *   npx tsx scripts/probe-rank1-margin.ts
 *   npx tsx scripts/probe-rank1-margin.ts --depth 50
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { embed } from "@/lib/embedder";
import { loadEnv } from "./lib/env";
import { expandSynsets, searchGlossSynsets } from "../lib/glossSearch";
import { contentTokens, echoesQuery } from "./lib/probes";

loadEnv();

const prisma = new PrismaClient();
const SET = "eval/sets/v1.jsonl";

/**
 * Gap bands, in cosine.
 *
 * The boundaries are judgement and are stated rather than tuned: 0.01 is below
 * the noise a tie-break decides, and 0.08 is the scale of the *whole* lemma-era
 * echo margin (+0.094), so anything past it is a gap as large as the problem
 * RD-02 was built to fix.
 */
const BANDS: { label: string; upto: number }[] = [
  { label: "< 0.01  (effectively a tie)", upto: 0.01 },
  { label: "0.01 - 0.03", upto: 0.03 },
  { label: "0.03 - 0.08", upto: 0.08 },
  { label: "> 0.08  (structural)", upto: Infinity },
];

type Row = {
  id: string;
  query: string;
  target: string;
  source: string;
  meta: { reachable?: boolean; acceptable?: string[] };
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

async function main(): Promise<void> {
  const depth = Number(arg("--depth") ?? 100);

  const rows: Row[] = fs
    .readFileSync(path.resolve(process.cwd(), SET), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row)
    .filter((r) => r.source === "authored" && r.meta.reachable !== false);

  console.log(`\nRD-21 · rank-1 margin   depth ${depth}   n=${rows.length} authored reachable\n`);

  // Neon auto-suspends; the first query otherwise pays the wake-up.
  await prisma.$queryRawUnsafe("SELECT 1");

  const gaps: number[] = [];
  const bandCounts = BANDS.map(() => 0);
  let atRank1 = 0;
  let never = 0;
  let winnerSum = 0;
  let targetSum = 0;
  let winnerEchoes = 0;
  const worst: { query: string; target: string; winner: string; gap: number }[] = [];

  let done = 0;
  for (const row of rows) {
    const vector = await embed(row.query);
    const hits = await searchGlossSynsets(prisma, `[${vector.join(",")}]`, depth);
    const ranked = expandSynsets(hits, depth);

    const accept = [row.target, ...(row.meta.acceptable ?? [])].map((w) => w.toLowerCase());
    const at = ranked.findIndex((r) => accept.includes(r.word.toLowerCase()));

    if (at === -1) {
      never++;
    } else if (at === 0) {
      atRank1++;
    } else {
      const gap = ranked[0].similarity - ranked[at].similarity;
      gaps.push(gap);
      bandCounts[BANDS.findIndex((b) => gap < b.upto)]++;
      winnerSum += ranked[0].similarity;
      targetSum += ranked[at].similarity;
      if (echoesQuery(ranked[0].word, contentTokens(row.query))) winnerEchoes++;
      worst.push({ query: row.query, target: row.target, winner: ranked[0].word, gap });
    }
    if (++done % 25 === 0) process.stdout.write(`\r  scored ${done}/${rows.length}`);
  }
  console.log(`\r  scored ${done}/${rows.length}\n`);

  const n = rows.length;
  const headroom = gaps.length;
  const pct = (v: number) => `${((100 * v) / n).toFixed(1)}%`;

  console.log(`  target at rank 1            ${String(atRank1).padStart(4)}   ${pct(atRank1)}`);
  console.log(`  in top ${String(depth).padEnd(3)} but not rank 1  ${String(headroom).padStart(4)}   ${pct(headroom)}   <- the headroom every ticket cites`);
  console.log(`  never retrieved             ${String(never).padStart(4)}   ${pct(never)}   <- out of reach at ANY rerank depth`);

  gaps.sort((a, b) => a - b);
  console.log(`\n  cosine gap, rank 1 -> target, across the headroom slice`);
  console.log(
    `    p10 ${percentile(gaps, 10).toFixed(4)}   p25 ${percentile(gaps, 25).toFixed(4)}   ` +
      `median ${percentile(gaps, 50).toFixed(4)}   p75 ${percentile(gaps, 75).toFixed(4)}   ` +
      `p90 ${percentile(gaps, 90).toFixed(4)}`
  );
  console.log(
    `    mean similarity   winner ${(winnerSum / headroom).toFixed(4)}   ` +
      `target ${(targetSum / headroom).toFixed(4)}   ` +
      `gap ${((winnerSum - targetSum) / headroom).toFixed(4)}`
  );

  console.log(`\n  how far below rank 1 the target sits`);
  BANDS.forEach((band, i) => {
    const share = (100 * bandCounts[i]) / headroom;
    const bar = "#".repeat(Math.round(share / 2));
    console.log(`    ${band.label.padEnd(28)} ${String(bandCounts[i]).padStart(4)}  ${share.toFixed(1).padStart(5)}%  ${bar}`);
  });

  const nearTies = bandCounts[0] + bandCounts[1];
  console.log(
    `\n  near-ties (< 0.03) are ${((100 * nearTies) / headroom).toFixed(1)}% of the headroom — ` +
      `${((100 * (headroom - nearTies)) / headroom).toFixed(1)}% is a confident margin.`
  );
  console.log(
    `  the winner echoes the query in ${winnerEchoes} of ${headroom} cases ` +
      `(${((100 * winnerEchoes) / headroom).toFixed(1)}%)`
  );

  console.log(`\n  widest gaps — where the encoder is most confidently wrong:`);
  for (const w of worst.sort((a, b) => b.gap - a.gap).slice(0, 8)) {
    console.log(`    ${w.gap.toFixed(3)}  want ${w.target} — got ${w.winner}`);
    console.log(`           "${w.query}"`);
  }

  console.log(
    `\n  READ IT AS: a perfect reranker over this shortlist lands R@1 at the depth-${depth}\n` +
      `  figure, but it has to overturn the margins above to get there — not break ties.\n` +
      `  A shortlist of near-misses and one of confident errors give the same headroom.\n`
  );

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  return prisma.$disconnect();
});
