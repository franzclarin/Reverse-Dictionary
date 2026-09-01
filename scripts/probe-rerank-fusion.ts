/**
 * Does combining the two rankings work better than either alone?
 *
 * The second model lost to plain search, and the obvious objection is that it
 * replaced a good signal rather than adding to it. So this blends the two
 * orderings and checks.
 *
 * The blending rule has no setting to tune — its one constant comes from the
 * paper that introduced it — and it uses only positions, so it cannot be
 * flattered by the two scores being on different scales. A weighted blend of the
 * raw scores would need a weight, and fitting that weight on this many questions
 * is exactly the benchmark-fitting this project flags itself for elsewhere. A
 * control has to be untunable to be worth anything.
 *
 * Reads a saved shortlist and nothing else — no database, no model. That is the
 * whole argument for having saved it: this question arrived after the runs were
 * finished, and answering it cost one file read instead of hours of recomputing.
 *
 *   npx tsx scripts/probe-rerank-fusion.ts eval/runs/<tag>.shortlist.jsonl
 */
import fs from "node:fs";
import path from "node:path";
import { expandSynsets, type SynsetHit } from "../lib/glossSearch";
import type { EvalRow } from "./build-eval-set";

const RRF_K = 60;
const DEPTHS = [10, 25, 50, 100];

type Candidate = SynsetHit & { gloss: string; sim: number; ce?: number };
type ShortlistRow = { id: string; query: string; target: string; candidates: Candidate[] };

const norm = (s: string) => s.trim().toLowerCase();

function readSet(file: string): Map<string, EvalRow> {
  return new Map(
    fs
      .readFileSync(path.resolve(process.cwd(), file), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EvalRow)
      .map((row) => [row.id, row])
  );
}

/** Rename the score field to the one the expansion helper expects. */
function asHits(candidates: Candidate[]): SynsetHit[] {
  return candidates.map((c) => ({
    synsetKey: c.synsetKey,
    lemmas: c.lemmas,
    similarity: c.sim,
  }));
}

/** Best first, ties broken by search order — the same rule the scorer uses. */
function reorder(
  candidates: Candidate[],
  depth: number,
  key: (c: Candidate, at: number) => number
): SynsetHit[] {
  const head = candidates
    .slice(0, depth)
    .map((c, at) => ({ c, at, score: key(c, at) }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((x) => x.c);
  return asHits([...head, ...candidates.slice(depth)]);
}

function lenientRank(words: string[], row: EvalRow): number | null {
  const acceptable = [row.target, ...(row.meta.acceptable ?? [])].map(norm);
  const i = words.map(norm).findIndex((w) => acceptable.includes(w));
  return i === -1 ? null : i + 1;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: npx tsx scripts/probe-rerank-fusion.ts eval/runs/<tag>.shortlist.jsonl");
    process.exitCode = 1;
    return;
  }

  const set = readSet("eval/sets/v1.jsonl");
  const rows = fs
    .readFileSync(path.resolve(process.cwd(), file), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ShortlistRow)
        // Headline questions only, matching the scorer.
    .filter((r) => {
      const meta = set.get(r.id);
      return meta?.source === "authored" && meta.meta.reachable !== false;
    });

  console.log(`\n  ${path.basename(file)} — authored reachable, n = ${rows.length}\n`);
  console.log(`  ${"order".padEnd(12)} ${"depth".padStart(5)}   ${"lenR@1".padStart(7)} ${"lenR@10".padStart(7)}`);

  const report = (label: string, depth: number, order: (r: ShortlistRow) => SynsetHit[]) => {
    let at1 = 0;
    let at10 = 0;
    for (const row of rows) {
      const words = expandSynsets(order(row), 100).map((w) => w.word);
      const rank = lenientRank(words, set.get(row.id)!);
      if (rank === 1) at1++;
      if (rank !== null && rank <= 10) at10++;
    }
    const pct = (n: number) => `${((100 * n) / rows.length).toFixed(1)}%`;
    console.log(
      `  ${label.padEnd(12)} ${String(depth).padStart(5)}   ${pct(at1).padStart(7)} ${pct(at10).padStart(7)}`
    );
  };

    // The original search order — the number to beat.
  report("retrieval", 100, (r) => asHits(r.candidates));

  for (const depth of DEPTHS) {
    report("cross-enc", depth, (r) => reorder(r.candidates, depth, (c) => c.ce ?? -Infinity));
  }

  for (const depth of DEPTHS) {
    report("rrf", depth, (r) => {
            // Each candidate's position according to the second model.
      const ceRank = new Map<number, number>();
      r.candidates
        .slice(0, depth)
        .map((c, at) => ({ at, ce: c.ce ?? -Infinity }))
        .sort((a, b) => b.ce - a.ce || a.at - b.at)
        .forEach((x, i) => ceRank.set(x.at, i));
      return reorder(
        r.candidates,
        depth,
        (_c, at) => 1 / (RRF_K + at) + 1 / (RRF_K + (ceRank.get(at) ?? depth))
      );
    });
  }
  console.log("");
}

main();
