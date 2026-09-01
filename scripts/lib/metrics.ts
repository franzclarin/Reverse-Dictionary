// The scores, and the test for whether a difference between two runs is real.
// Kept apart from the runner so two saved runs can be compared without touching
// the database or the model.

/** One candidate the re-sorting model saw, in the order search returned it. */
// Saved because a run that throws its shortlist away cannot be re-scored at a
// different depth, or checked at all. Definition text is left out — it can be
// looked up from the key, and inlining it would bloat every saved run.
export type ShortlistEntry = {
  synsetKey: string;
  sim: number;
    /** Missing when this entry sat too far down to be re-scored. */
  ce?: number;
};

export type QueryResult = {
  id: string;
  query: string;
  target: string;
  source: string;
    /** The words returned, best first. */
  results: string[];
  similarities: number[];
    /** Where the right answer came, or null if it never appeared. */
  rank: number | null;
    /** Where the best acceptable answer came. */
  lenientRank: number | null;
    /** How much of the top ten merely echoes a word from the question. */
  echo: number;
  meta: Record<string, unknown>;
  embedMs: number;
  dbMs: number;
    /** Re-sorting runs only: how long the second model took on this question. */
  rerankMs?: number;
    /** Re-sorting runs only: what was re-sorted, in the order search returned it. */
  shortlist?: ShortlistEntry[];
};

export type Metrics = {
  n: number;
  recall1: number;
  recall3: number;
  recall10: number;
  mrr10: number;
  lenientRecall1: number;
  lenientRecall10: number;
  echoRate: number;
    /** Share where the right answer was found, but not in the top ten. */
  beyond10: number;
};

function hit(rank: number | null, k: number): boolean {
  return rank !== null && rank <= k;
}

export function score(results: QueryResult[]): Metrics {
  const n = results.length;
  if (n === 0) {
    return {
      n: 0,
      recall1: NaN,
      recall3: NaN,
      recall10: NaN,
      mrr10: NaN,
      lenientRecall1: NaN,
      lenientRecall10: NaN,
      echoRate: NaN,
      beyond10: NaN,
    };
  }

  const mean = (f: (r: QueryResult) => number) =>
    results.reduce((s, r) => s + f(r), 0) / n;

  return {
    n,
    recall1: mean((r) => (hit(r.rank, 1) ? 1 : 0)),
    recall3: mean((r) => (hit(r.rank, 3) ? 1 : 0)),
    recall10: mean((r) => (hit(r.rank, 10) ? 1 : 0)),
    mrr10: mean((r) => (hit(r.rank, 10) ? 1 / r.rank! : 0)),
    lenientRecall1: mean((r) => (hit(r.lenientRank, 1) ? 1 : 0)),
    lenientRecall10: mean((r) => (hit(r.lenientRank, 10) ? 1 : 0)),
    echoRate: mean((r) => r.echo),
    beyond10: mean((r) => (r.rank !== null && r.rank > 10 ? 1 : 0)),
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Tests whether two runs really differ, by looking only at where they disagree. */
// Comparing two overall percentages at this sample size cannot see a
// three-point change. Comparing them question by question can, because it
// throws away every question both runs get right — which is where the noise is.
export function mcnemar(b: number, c: number): { p: number; n: number } {
  const n = b + c;
  if (n === 0) return { p: 1, n: 0 };

    // Two-sided: how likely a split this lopsided would be from coin flips.
  const lo = Math.min(b, c);
  let logC = 0; // log of the binomial coefficient, kept in logs for large n
  let sum = 0;
  for (let i = 0; i <= lo; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    sum += Math.exp(logC + n * Math.log(0.5));
  }
  return { p: Math.min(1, 2 * sum), n };
}
