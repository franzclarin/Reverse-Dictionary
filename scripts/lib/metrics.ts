/**
 * Retrieval metrics and the paired significance test.
 *
 * Kept apart from the runner so `--compare` can score two saved runs without
 * touching the database or the model.
 */

/**
 * One candidate the cross-encoder saw, in RETRIEVAL order (RD-12).
 *
 * `sim` is the bi-encoder cosine that put it in the shortlist; `ce` is the
 * cross-encoder's raw logit for the pair. Persisted because a run whose
 * shortlist is gone cannot be re-scored at a different depth, or audited at
 * all — before RD-12 every run stored only its top 10 while computing ranks to
 * depth 100, so the shortlist the whole ticket is about was thrown away.
 *
 * Gloss text is deliberately NOT stored here: it is recoverable from
 * `synsetKey`, and inlining it would quadruple the size of a committed
 * reference run. The full detail, gloss included, goes to the sidecar
 * `eval/runs/<tag>.shortlist.jsonl`.
 */
export type ShortlistEntry = {
  synsetKey: string;
  sim: number;
  /** Absent when the entry sat beyond the rerank depth and was never scored. */
  ce?: number;
};

export type QueryResult = {
  id: string;
  query: string;
  target: string;
  source: string;
  /** Returned words, best first. */
  results: string[];
  similarities: number[];
  /** 1-based rank of the target within the deep scan, or null if absent. */
  rank: number | null;
  /** 1-based rank of the best acceptable answer (target included). */
  lenientRank: number | null;
  /** Share of the top-10 sharing a stem with a query content word. */
  echo: number;
  meta: Record<string, unknown>;
  embedMs: number;
  dbMs: number;
  /** RD-12, rerank runs only: cross-encoder wall time for this query. */
  rerankMs?: number;
  /**
   * RD-12, rerank runs only: the candidates the cross-encoder re-sorted, in
   * retrieval order. Optional so every run committed before RD-12 still loads.
   */
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
  /** Share whose target is somewhere in the deep scan but outside the top 10. */
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

/**
 * Exact two-sided McNemar test on rank-1 disagreements.
 *
 * Comparing two independent Recall@1 figures at n=300 cannot see a three-point
 * change. The paired test can, because it discards every query both runs get
 * right — which is exactly where the variance lives — and looks only at the
 * discordant pairs. The exact binomial form is used rather than the chi-square
 * approximation because b + c is often small.
 */
export function mcnemar(b: number, c: number): { p: number; n: number } {
  const n = b + c;
  if (n === 0) return { p: 1, n: 0 };

  // Two-sided: 2 * P(X <= min(b,c)) under X ~ Binomial(n, 0.5).
  const lo = Math.min(b, c);
  let logC = 0; // log of the binomial coefficient, kept in logs for large n
  let sum = 0;
  for (let i = 0; i <= lo; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    sum += Math.exp(logC + n * Math.log(0.5));
  }
  return { p: Math.min(1, 2 * sum), n };
}
