/**
 * Does fusing the cross-encoder with retrieval rank rescue RD-12?
 *
 * Recorded as a control for the RD-12 write-up (METHODS §13). The off-the-shelf
 * cross-encoder LOST to plain retrieval on lenient R@1, and the obvious
 * objection is that reranking replaced a good signal rather than adding to it —
 * so this checks whether combining the two orders does better than either.
 *
 * Reciprocal Rank Fusion, deliberately:
 *
 *   score(candidate) = 1/(60 + retrievalRank) + 1/(60 + crossEncoderRank)
 *
 * RRF has NO free parameter to fit (60 is the constant from the original paper,
 * not something tuned here) and it consumes only ranks, so it cannot be
 * flattered by the two scores living on different scales. A weighted blend of
 * cosine and logit would need a weight, and fitting that weight on a 287-query
 * set is exactly the benchmark-fitting this project already flags itself for
 * elsewhere (CLAUDE.md, on the expansion-order tie-break). A control has to be
 * unfittable to be worth anything.
 *
 * Reads a PERSISTED shortlist and nothing else — no database, no model. That is
 * the whole argument for having persisted it: this question arrived after the
 * runs were finished, and answering it cost one file read instead of another
 * 405 embeddings and 40,500 forward passes.
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

/** Candidates carry `sim`, not `similarity` — restore the shape expandSynsets wants. */
function asHits(candidates: Candidate[]): SynsetHit[] {
  return candidates.map((c) => ({
    synsetKey: c.synsetKey,
    lemmas: c.lemmas,
    similarity: c.sim,
  }));
}

/** Descending by `key`, ties broken by retrieval order — the same policy as eval.ts. */
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
    // Headline scope, matching eval.ts: authored and reachable.
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

  // The un-reranked order the shortlist was retrieved in — the number to beat.
  report("retrieval", 100, (r) => asHits(r.candidates));

  for (const depth of DEPTHS) {
    report("cross-enc", depth, (r) => reorder(r.candidates, depth, (c) => c.ce ?? -Infinity));
  }

  for (const depth of DEPTHS) {
    report("rrf", depth, (r) => {
      // Cross-encoder RANK per candidate, keyed by its retrieval position.
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
