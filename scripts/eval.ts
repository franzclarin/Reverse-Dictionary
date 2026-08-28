/**
 * The evaluation harness.
 *
 * Measures the production retrieval path — `embed(query)` then pgvector top-k
 * over the index — against a frozen set of (description -> word) pairs. The
 * query is a mirror of `app/api/lookup/route.ts` via `lib/retrieval.ts`, and
 * the embedder is imported from `lib/embedder.ts` rather than reimplemented,
 * so the numbers describe production rather than a lookalike.
 *
 *   npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --tag baseline
 *   npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --exact --tag exact
 *   npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --filter-junk --tag filtered
 *   npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --index EvalPoolGloss --per-sense --tag gloss
 *   npx tsx scripts/eval.ts --compare eval/runs/baseline.json eval/runs/gloss.json
 *
 * Flags:
 *   --k <n>            results per query for the headline metrics (default 10)
 *   --probes <n>       ivfflat.probes (default 10, matching production)
 *   --exact            sequential scan — the true nearest-neighbour ceiling
 *   --filter-junk      restrict the pool with the Phase A junk predicate
 *   --index <table>    search an alternative index table in Postgres
 *   --index-file <cell> search a local file-backed index (the Phase E 2x2 cells;
 *                      exhaustive, so exact by construction)
 *   --per-sense        table has one row per (word, sense); dedupe by word
 *   --expansion-order <wordnet|zipf|index>
 *                      synset cells only: how to order the member words a
 *                      retrieved synset expands into.
 *                      `wordnet` (default) uses WordNet's own sense-familiarity
 *                      order; `zipf` guesses the commonest mate first; `index`
 *                      keeps stored order
 *   --model <id>       embedding model override (for the base-model control)
 *   --rank-depth <n>   how deep to look for the target (default 100)
 *   --no-deep          skip the deep scan (headline metrics only)
 *   --rerank           RD-12: re-sort the retrieved shortlist with a cross-encoder
 *                      before scoring. Gloss index only.
 *   --rerank-depth <n> how many synsets the cross-encoder re-sorts (default 50)
 *   --rerank-model <id>  cross-encoder to score with
 *   --rerank-quantized   load the int8 ONNX weights instead of fp32
 *   --rerank-input <gloss|lemma-gloss>
 *                      what text the cross-encoder sees per candidate
 *   --rerank-sweep <a,b,c>
 *                      also report the metrics at these shallower rerank depths.
 *                      Free: a depth-D re-sort is a prefix of the depth-100 scores.
 *   --bands <n>        5 = fixed Zipf bands, 3 = data-driven terciles
 *   --freq <file>      Zipf table (default eval/data/zipf-en.tsv)
 *   --limit <n>        only score the first n rows (smoke testing)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { embed } from "@/lib/embedder";
import { embedWith, PRODUCTION_MODEL } from "./lib/embedModel";
import { loadEnv } from "./lib/env";
import { search, DEFAULT_INDEX, PRODUCTION_PROBES, type ResultRow } from "./lib/retrieval";
import {
  GLOSS_INDEX,
  GLOSS_PROBES,
  expandSynsets,
  searchGlossSynsets,
  type GlossSynsetHit,
  type SynsetHit,
} from "../lib/glossSearch";
import {
  DEFAULT_RERANK_MODEL,
  RERANK_FINDING,
  rerankText,
  scorePairs,
  warmReranker,
  type RerankInput,
} from "./lib/reranker";
import {
  loadIndex,
  prepareQuery,
  type ExpandOrder,
  searchLocal,
  searchLocalSynsets,
  scaleOf,
  type LocalIndex,
} from "./lib/localIndex";
import { contentTokens, echoesQuery } from "./lib/probes";
import { bandOf, loadZipf } from "./lib/freq";
import { POS_LIST, readSenses } from "./lib/wordnet";
import {
  score,
  percentile,
  mcnemar,
  type QueryResult,
  type Metrics,
  type ShortlistEntry,
} from "./lib/metrics";
import type { EvalRow } from "./build-eval-set";

loadEnv();

const prisma = new PrismaClient();
const RUNS_DIR = path.resolve(process.cwd(), "eval/runs");

/**
 * Pre-registered, recorded in every run so it cannot be retrofitted:
 * 258 orphaned verbs out of 11,540 is 2.2% of the verb inventory — too small
 * to move a whole style slice. If `narrative` recall lands materially below
 * the other styles, the orphaned verbs are almost certainly NOT the
 * explanation, and the finding points back at the representation.
 */
const PREREGISTERED_NOTE =
  "Pre-registered (Phase A2/POS audit): orphaned verbs are 2.2% of the verb " +
  "inventory, too few to move the narrative slice. Low narrative recall " +
  "implicates the representation, not vocabulary coverage.";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function numArg(flag: string, fallback: number): number {
  const v = arg(flag);
  return v === undefined ? fallback : Number(v);
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function readSet(file: string): EvalRow[] {
  return fs
    .readFileSync(path.resolve(process.cwd(), file), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalRow);
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Hash of the eval set as it was when this run scored it.
 *
 * The set is frozen once built, so a run and its set are meant to be a matched
 * pair forever. Recording the hash *in the run* is what makes that checkable
 * later: `report.ts` compares it against the file on disk and shouts if they
 * have diverged, which is the only way an in-place edit would ever be caught.
 * Matches `build-eval-set.ts` — both hash the file's exact bytes.
 */
function sha256File(file: string): string | null {
  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.resolve(process.cwd(), file)))
      .digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- reporting

function fmtPct(n: number): string {
  return Number.isNaN(n) ? "  n/a" : `${(n * 100).toFixed(1)}%`;
}

function metricsLine(label: string, m: Metrics): string {
  return (
    `  ${label.padEnd(22)} ${String(m.n).padStart(4)}  ` +
    `${fmtPct(m.recall1).padStart(6)} ${fmtPct(m.recall3).padStart(6)} ${fmtPct(m.recall10).padStart(6)}  ` +
    `${(Number.isNaN(m.mrr10) ? NaN : m.mrr10).toFixed(3).padStart(5)}  ` +
    `${fmtPct(m.lenientRecall1).padStart(6)}  ${fmtPct(m.echoRate).padStart(6)}`
  );
}

const METRICS_HEADER =
  `  ${"slice".padEnd(22)} ${"n".padStart(4)}  ${"R@1".padStart(6)} ${"R@3".padStart(6)} ${"R@10".padStart(6)}  ` +
  `${"MRR".padStart(5)}  ${"lenR@1".padStart(6)}  ${"echo".padStart(6)}`;

/**
 * Lenient/strict recall at increasing depth — the reranker budget, stated.
 *
 * Read as: recall at depth D is the ceiling for a PERFECT reranker over a
 * D-deep shortlist, and `1 - R@maxDepth` is the share no reranker of any depth
 * can reach, because the target was never retrieved. Keeping the two apart is
 * the point; RD-12's ceiling is 77.0%, not 100%, and citing the wrong one
 * repeats the mistake of quoting a number measured under conditions that do
 * not hold.
 */
const LADDER_DEPTHS = [1, 3, 10, 50, 100];

function recallLadder(results: QueryResult[], maxDepth: number): string[] {
  const depths = LADDER_DEPTHS.filter((d) => d <= maxDepth);
  const at = (pick: (r: QueryResult) => number | null, d: number) =>
    fmtPct(results.filter((r) => pick(r) !== null && pick(r)! <= d).length / results.length);

  return [
    `    depth      ${depths.map((d) => String(d).padStart(6)).join(" ")}`,
    `    lenient R@ ${depths.map((d) => at((r) => r.lenientRank, d).padStart(6)).join(" ")}`,
    `    strict  R@ ${depths.map((d) => at((r) => r.rank, d).padStart(6)).join(" ")}`,
  ];
}

function reportSlices(
  title: string,
  results: QueryResult[],
  key: (r: QueryResult) => string | undefined
): void {
  const groups = new Map<string, QueryResult[]>();
  for (const r of results) {
    const k = key(r);
    if (k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  if (groups.size === 0) return;

  console.log(`\n  by ${title}:`);
  console.log(METRICS_HEADER);
  for (const [k, rows] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(metricsLine(k, score(rows)));
  }
}

function lengthBucket(query: string): string {
  const n = query.trim().split(/\s+/).length;
  if (n <= 8) return "<=8 words";
  if (n <= 12) return "9-12 words";
  if (n <= 16) return "13-16 words";
  return "17+ words";
}

/** Fixed Zipf bands, or data-driven terciles when the fixed ones are lopsided. */
function bandLabeller(results: QueryResult[], bands: number): (r: QueryResult) => string | undefined {
  if (bands !== 3) return (r) => (r.meta.zipf === undefined ? "unknown" : bandOf(r.meta.zipf as number));

  const zipfs = results
    .map((r) => r.meta.zipf as number | undefined)
    .filter((z): z is number => typeof z === "number")
    .sort((a, b) => a - b);
  if (zipfs.length < 3) return () => "unknown";

  const lo = zipfs[Math.floor(zipfs.length / 3)];
  const hi = zipfs[Math.floor((2 * zipfs.length) / 3)];
  return (r) => {
    const z = r.meta.zipf as number | undefined;
    if (typeof z !== "number") return "unknown";
    if (z < lo) return `low (<${lo.toFixed(2)})`;
    if (z < hi) return `mid (${lo.toFixed(2)}-${hi.toFixed(2)})`;
    return `high (>=${hi.toFixed(2)})`;
  };
}

// ------------------------------------------------------------------- compare

function compare(fileA: string, fileB: string): void {
  const load = (f: string) =>
    JSON.parse(fs.readFileSync(path.resolve(process.cwd(), f), "utf8")) as {
      tag: string;
      config: Record<string, unknown>;
      results: QueryResult[];
    };
  const a = load(fileA);
  const b = load(fileB);

  const byId = new Map(b.results.map((r) => [r.id, r]));
  const paired = a.results
    .map((ra) => ({ ra, rb: byId.get(ra.id) }))
    .filter((p): p is { ra: QueryResult; rb: QueryResult } => p.rb !== undefined);

  console.log(`\nPaired comparison: ${a.tag} vs ${b.tag}`);
  console.log(`  ${paired.length} queries present in both runs`);
  if (paired.length !== a.results.length || paired.length !== b.results.length) {
    console.log(
      `  (${a.results.length} in ${a.tag}, ${b.results.length} in ${b.tag} — scoring the intersection)`
    );
  }

  console.log(`\n${METRICS_HEADER}`);
  console.log(metricsLine(a.tag, score(paired.map((p) => p.ra))));
  console.log(metricsLine(b.tag, score(paired.map((p) => p.rb))));

  // The reranker budget for each run, side by side: how much of the gap between
  // R@1 and the deepest column is reordering work, and how much is never
  // retrieved and so out of a reranker's reach entirely.
  const depthOf = (r: { config: Record<string, unknown> }) => Number(r.config.rankDepth ?? 10);
  const ladderDepth = Math.min(depthOf(a), depthOf(b));
  if (ladderDepth > 10) {
    const scopeOf = (rows: QueryResult[]) => {
      const reach = rows.filter((r) => r.meta.reachable !== false);
      const auth = reach.filter((r) => r.source === "authored");
      return auth.length ? auth : reach;
    };
    console.log(`\n  recall by depth — ${a.tag}`);
    for (const line of recallLadder(scopeOf(paired.map((q) => q.ra)), ladderDepth)) console.log(line);
    console.log(`\n  recall by depth — ${b.tag}`);
    for (const line of recallLadder(scopeOf(paired.map((q) => q.rb)), ladderDepth)) console.log(line);
  }

  /**
   * Both metrics get their own paired test.
   *
   * METHODS §9a fixed the decision rule to resolve on LENIENT R@1 — rank 1
   * against the hand-authored `acceptable[]` list — because strict R@1 is
   * tie-deflated on a gloss index, where synset mates hold identical vectors.
   * Until RD-12 this function tested strict rank-1 only, so the one number the
   * rule actually resolves on was the one number it could not see.
   *
   * They are reported side by side, never merged: a reranker that reorders
   * across synonyms moves strict R@1 without moving lenient R@1 on the 133 rows
   * that carry `acceptable[]`, and moves both on the other 179 (METHODS §8.6).
   * One figure alone would misattribute that.
   */
  // §9a resolves on the HEADLINE SLICE — authored and reachable — not on every
  // row in the file. Scoring the paired test over all 405 would dilute it with
  // the 93 quarantined tripwire rows (leakage=paraphrase, explicitly never a
  // headline number) and the 25 unreachable coverage rows, and would divide the
  // delta by the wrong denominator: a 3-point move on 287 queries reads as 2.1
  // over 405. Every other number this project records is the 287-row slice, and
  // a verdict line has to be on the same footing as the table beside it.
  const scoped = paired.filter(
    (q) => q.ra.source === "authored" && q.ra.meta.reachable !== false
  );

  const testRank1 = (
    label: string,
    pick: (r: QueryResult) => number | null,
    decisive: boolean
  ) => {
    const hit = (r: QueryResult) => pick(r) === 1;
    const regressed = scoped.filter((q) => hit(q.ra) && !hit(q.rb));
    const won = scoped.filter((q) => !hit(q.ra) && hit(q.rb));
    const { p, n } = mcnemar(regressed.length, won.length);
    // Difference of the two runs' recall on this slice — which, for a binary
    // rank-1 outcome, is exactly (wins - regressions) / n.
    const delta = (won.length - regressed.length) / (scoped.length || 1);

    console.log(
      `\n  McNemar on ${label} rank-1 disagreements (exact, two-sided), ` +
        `authored reachable n=${scoped.length}` +
        `${decisive ? "   <- the metric METHODS 9a resolves on" : ""}`
    );
    console.log(`    ${a.tag} right / ${b.tag} wrong : ${regressed.length}`);
    console.log(`    ${a.tag} wrong / ${b.tag} right : ${won.length}`);
    console.log(
      `    delta = ${(delta * 100 >= 0 ? "+" : "")}${(delta * 100).toFixed(1)} points   ` +
        `discordant pairs n = ${n}   p = ${p.toFixed(5)}`
    );
    console.log(
      `    ${p < 0.05 ? "SIGNIFICANT at 0.05" : "not significant at 0.05"}` +
        ` — the ${scoped.length - n} queries both runs agree on carry no information here.`
    );
    if (decisive) {
      // Rendered from the delta rather than left to a reader's optimism: a
      // positive result below the pre-committed ~6-point bar is a NULL RESULT
      // and is not to be acted on, significance notwithstanding.
      const verdict =
        delta >= 0.06 && p < 0.05
          ? "WIN under 9a"
          : delta >= 0.06
            ? "above the 6-point bar but not significant"
            : delta > 0
              ? "NULL RESULT — positive but below the ~6-point bar, not to be acted on"
              : p < 0.05
                ? "SIGNIFICANT REGRESSION"
                : "no difference";
      console.log(`    METHODS 9a verdict: ${verdict}`);
    }
    return { wins: won, regressions: regressed };
  };

  testRank1("lenient", (r) => r.lenientRank, true);
  const { wins, regressions } = testRank1("strict", (r) => r.rank, false);
  if (scoped.length !== paired.length) {
    console.log(
      `\n  (the metrics table above is all ${paired.length} paired rows; the tests above are the ` +
        `${scoped.length}-row\n   authored reachable slice, which is what every headline number here means)`
    );
  }

  const show = (label: string, rows: { ra: QueryResult; rb: QueryResult }[]) => {
    if (!rows.length) return;
    console.log(`\n  ${label} (${rows.length}):`);
    for (const { ra, rb } of rows.slice(0, 25)) {
      console.log(`    "${ra.query}"`);
      console.log(
        `      want ${ra.target}   ${a.tag}: ${ra.results[0]} (rank ${ra.rank ?? ">depth"})` +
          `   ${b.tag}: ${rb.results[0]} (rank ${rb.rank ?? ">depth"})`
      );
    }
    if (rows.length > 25) console.log(`    ... and ${rows.length - 25} more`);
  };
  show(`WINS for ${b.tag}`, wins);
  show(`REGRESSIONS under ${b.tag}`, regressions);

  const echoA = score(paired.map((p) => p.ra)).echoRate;
  const echoB = score(paired.map((p) => p.rb)).echoRate;
  console.log(
    `\n  echo rate ${fmtPct(echoA)} -> ${fmtPct(echoB)} (${((echoB - echoA) * 100).toFixed(1)} points)`
  );
  console.log(
    `  A change that moves recall without moving echo rate needs explaining: echo is\n` +
      `  the mechanism, so a real representation fix should move both.`
  );
  console.log(`\n  ${PREREGISTERED_NOTE}\n`);
}

// ------------------------------------------------------- synset expansion

type ExpansionOrder = "wordnet" | "zipf" | "index";

/**
 * How a retrieved synset is unpacked into the member words the answer key is
 * written in.
 *
 * Synset mates carry bit-identical vectors, so retrieval genuinely cannot
 * separate them: this is a POLICY, not a result. It must be chosen deliberately,
 * and it must not be able to see the answer key.
 *
 *   wordnet  the order WordNet itself lists a synset's words in, which is by
 *            sense familiarity. Independent of this benchmark, and the best of
 *            the three at putting the authored target first (51.8% of
 *            multi-word synsets against 42.7% for zipf). Production default.
 *   zipf     commonest word first. Defensible a priori — if you cannot tell
 *            `bungle` from `botch`, guess the commoner — but measurably the
 *            worst of the three here.
 *   index    stored member order. Neutral only because the pool is now shuffled;
 *            before that fix this WAS the answer key (METHODS.md §12). Kept for
 *            comparison, never for production.
 */
function expansionOrderFn(kind: ExpansionOrder): ExpandOrder {
  if (kind === "index") return (_key, members) => members;

  if (kind === "zipf") {
    const zipf = loadZipf();
    const rank = (w: string) => zipf.get(w.toLowerCase()) ?? 0;
    return (_key, members) => [...members].sort((a, b) => rank(b) - rank(a));
  }

  // WordNet's own within-synset ordering, read straight from `data.<pos>`.
  const wnOrder = new Map<string, Map<string, number>>();
  for (const pos of POS_LIST) {
    for (const sense of readSenses(pos)) {
      const positions = new Map<string, number>();
      sense.words.forEach((w, i) => positions.set(w.toLowerCase(), i));
      wnOrder.set(`${sense.pos}:${sense.offset}`, positions);
    }
  }
  return (key, members) => {
    const positions = wnOrder.get(key);
    if (!positions) return members;
    // Anything WordNet does not list keeps its place after everything it does.
    return [...members].sort(
      (a, b) =>
        (positions.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
    );
  };
}

// ------------------------------------------------------------ scoring a row

/**
 * Score one query's result lists into a `QueryResult`.
 *
 * Extracted so the rerank depth sweep scores its alternate orderings through
 * the SAME code as the headline. Two scoring implementations would let a sweep
 * table disagree with the run it is printed beside for reasons nobody could
 * find.
 *
 * `top` (k results) drives what is reported and the echo rate; `ranked` (the
 * deep list) drives the target's true rank.
 */
function measure(
  row: EvalRow,
  top: ResultRow[],
  ranked: ResultRow[],
  embedMs: number,
  dbMs: number
): QueryResult {
  const lowered = ranked.map((r) => norm(r.word));
  const targetIdx = lowered.indexOf(norm(row.target));

  const acceptable = [row.target, ...(row.meta.acceptable ?? [])].map(norm);
  let lenientIdx = -1;
  for (let i = 0; i < lowered.length; i++) {
    if (acceptable.includes(lowered[i])) {
      lenientIdx = i;
      break;
    }
  }

  const tokens = contentTokens(row.query);
  const topTen = top.slice(0, 10).map((r) => r.word);
  const echo = topTen.length
    ? topTen.filter((w) => echoesQuery(w, tokens)).length / topTen.length
    : 0;

  return {
    id: row.id,
    query: row.query,
    target: row.target,
    source: row.source,
    results: top.map((r) => r.word),
    similarities: top.map((r) => r.similarity),
    rank: targetIdx === -1 ? null : targetIdx + 1,
    lenientRank: lenientIdx === -1 ? null : lenientIdx + 1,
    echo,
    meta: row.meta as unknown as Record<string, unknown>,
    embedMs,
    dbMs,
  };
}

// ------------------------------------------------------------ rerank stage

/**
 * Re-sort the first `depth` retrieved synsets by cross-encoder score, leaving
 * the tail exactly as retrieval ordered it.
 *
 * The tail matters: `rank` is measured to `--rank-depth` (100), so appending
 * the un-reordered remainder keeps the deep-rank statistic comparable against
 * a non-rerank run instead of silently truncating the measurement to the
 * shortlist. It is also what a serving reranker actually does.
 *
 * The tie-break is written out rather than left to sort stability. Equal
 * cross-encoder scores fall back to retrieval order, which is the only
 * answer-key-independent order available — METHODS §12 is an entire section
 * about a tie-break that quietly encoded the answer key, and the lesson there
 * is that a tie policy has to be a decision on the page, not an emergent
 * property of whichever sort the runtime happens to use.
 */
function rerankOrder(
  hits: GlossSynsetHit[],
  scores: number[],
  depth: number
): SynsetHit[] {
  const head = hits
    .slice(0, depth)
    .map((hit, at) => ({ hit, score: scores[at], at }))
    .sort((a, b) => b.score - a.score || a.at - b.at);

  return [...head.map((h) => h.hit), ...hits.slice(depth)];
}

// ----------------------------------------------------------------- the run

async function run(): Promise<void> {
  const setFile = arg("--set");
  const tag = arg("--tag");
  if (!setFile || !tag) {
    console.error("usage: npx tsx scripts/eval.ts --set <file.jsonl> --tag <name>");
    process.exitCode = 1;
    return;
  }

  const k = numArg("--k", 10);
  const exact = has("--exact");
  const filterJunk = has("--filter-junk");
  const index = arg("--index") ?? DEFAULT_INDEX;
  // Undefined unless asked for, so each index contributes its own production
  // default (lemma 10, gloss 40) rather than having the lemma value imposed on
  // everything. Recorded below as the value actually used, never as "10".
  const probes = has("--probes") ? numArg("--probes", PRODUCTION_PROBES) : undefined;
  const effectiveProbes = probes ?? (index === GLOSS_INDEX ? GLOSS_PROBES : PRODUCTION_PROBES);
  const indexFile = arg("--index-file");
  const perSense = has("--per-sense");

  // The Phase E cells live in local files rather than Postgres: the Neon
  // project is at its 512 MB limit with VocabEmbedding alone. A brute-force
  // scan of the pool is exact, so these runs carry no index error at all.
  let local: LocalIndex | undefined;
  if (indexFile) {
    local = loadIndex(indexFile);
    console.log(
      `  local index   ${local.meta.cell}: ${local.meta.rows.toLocaleString()} rows, ` +
        `${local.meta.distinctWords.toLocaleString()} distinct words, model ${local.meta.model}`
    );
  }
  // A synset cell stores one row per synset and must expand to member words
  // before anything can be scored against a word-level answer key. Ordering is
  // by descending Zipf: where retrieval genuinely cannot separate two synonyms
  // (their vectors are identical), the commoner word is the better guess.
  const synsetCell = local?.meta.variant === "gloss_synset";
  // Synset mates are bit-identical vectors, so which one surfaces first is a
  // pure tie-break, not a retrieval result. `zipf` is a deliberate policy —
  // guess the commoner word. `index` keeps the stored order, which is the same
  // arbitrary order a per-sense cell's stable sort leaves mates in, and is what
  // makes a synset cell comparable to a per-sense one on one held-constant axis.
  const expansionOrder = (arg("--expansion-order") ?? "wordnet") as ExpansionOrder;
  if (!["wordnet", "zipf", "index"].includes(expansionOrder)) {
    console.error(`--expansion-order must be wordnet|zipf|index, got "${expansionOrder}"`);
    process.exitCode = 1;
    return;
  }
  const expand: ExpandOrder = synsetCell
    ? expansionOrderFn(expansionOrder)
    : (_k: string, m: string[]) => m;
  if (synsetCell) {
    console.log(
      `  synset cell   expanding each hit to its member words (order: ${expansionOrder});
` +
        `                one synset can occupy several top-k slots, so these numbers are
` +
        `                NOT a drop-in substitute for a per-sense gloss cell`
    );
  }

  // The query encoder MUST match the model the cell was built with. Getting this
  // wrong is silent and fatal: embedding queries with the fine-tune while the
  // documents were encoded by the base model compares vectors from two different
  // spaces, and every number that comes out is meaningless. It reads as a
  // representation result. An earlier version defaulted to the production
  // embedder regardless of the cell, which would have invalidated both base-model
  // arms of the 2x2 while reporting the cell's model in the run config.
  const explicitModel = arg("--model");
  const model = explicitModel ?? local?.meta.model;
  const usesProductionEmbedder = !model || model === PRODUCTION_MODEL;
  if (explicitModel && local && explicitModel !== local.meta.model) {
    console.log(
      `
  *** WARNING: --model ${explicitModel} does not match the cell's model ` +
        `${local.meta.model}.
      Query and document vectors come from different spaces; ` +
        `the results are not interpretable. ***
`
    );
  }
  const rankDepth = numArg("--rank-depth", 100);
  const deep = !has("--no-deep") && rankDepth > k;

  // ------------------------------------------------------------- RD-12 rerank
  const rerank = has("--rerank");
  const rerankModel = arg("--rerank-model") ?? DEFAULT_RERANK_MODEL;
  const rerankQuantized = has("--rerank-quantized");
  const rerankInput = (arg("--rerank-input") ?? "gloss") as RerankInput;
  const rerankDepth = numArg("--rerank-depth", 50);
  const rerankSweep = (arg("--rerank-sweep") ?? "")
    .split(",")
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);

  if (rerank) {
    // Refuse rather than silently ignore, exactly as the gloss path in
    // scripts/lib/retrieval.ts refuses --exact/--filter-junk/--per-sense: a run
    // tagged `--rerank` that quietly reranked nothing would put a false claim
    // in eval/runs/*.json, and nobody would ever catch it.
    if (indexFile) {
      console.error("--rerank cannot apply to a local cell: the cells store vectors, not gloss text.");
      process.exitCode = 1;
      return;
    }
    if (index !== GLOSS_INDEX) {
      console.error(
        `--rerank requires --index ${GLOSS_INDEX}: the cross-encoder scores (query, gloss) pairs, ` +
          `and the lemma index has no gloss to show it. Scoring (query, bare lemma) would recreate ` +
          `the representation mismatch RD-02 exists to have fixed.`
      );
      process.exitCode = 1;
      return;
    }
    if (!["gloss", "lemma-gloss"].includes(rerankInput)) {
      console.error(`--rerank-input must be gloss|lemma-gloss, got "${rerankInput}"`);
      process.exitCode = 1;
      return;
    }
    if (!deep) {
      console.error(
        "--rerank needs the deep scan: the shortlist IS the deep scan, and without it " +
          "there is nothing to reorder and no rank to measure the reorder against."
      );
      process.exitCode = 1;
      return;
    }
    const tooDeep = [rerankDepth, ...rerankSweep].filter((d) => d > rankDepth);
    if (tooDeep.length) {
      console.error(
        `rerank depth ${tooDeep.join(", ")} exceeds --rank-depth ${rankDepth}; ` +
          `raise --rank-depth so the shortlist actually exists.`
      );
      process.exitCode = 1;
      return;
    }
  }
  const bands = numArg("--bands", 5);
  const limit = numArg("--limit", Infinity);

  let rows = readSet(setFile);
  if (Number.isFinite(limit)) rows = rows.slice(0, limit);

  // The eval set already carries a raw Zipf per row; --freq overrides it so a
  // different frequency source can be swapped in without rebuilding the set.
  const freqFile = arg("--freq");
  if (freqFile) {
    const table = loadZipf(freqFile);
    rows = rows.map((r) => ({
      ...r,
      meta: { ...r.meta, zipf: table.get(r.target.toLowerCase()) ?? r.meta.zipf },
    }));
  }

  const config = {
    set: setFile,
    setSha256: sha256File(setFile),
    k,
    probes: exact ? null : effectiveProbes,
    exact,
    filterJunk,
    index: indexFile ? `file:${indexFile}` : index,
    perSense,
    exactByConstruction: Boolean(indexFile),
    poolScope: local?.meta.note,
    // Cells of different scale are not comparable. Recorded per run so
    // `report.ts` can flag a cross-scale comparison instead of tabling it as
    // if the two numbers meant the same thing.
    poolScale: local ? scaleOf(local.meta) : undefined,
    poolWords: local?.meta.poolWords,
    cellVariant: local?.meta.variant,
    cellPrecision: local?.meta.precision ?? (local ? "float32" : undefined),
    cellDim: local?.meta.dim,
    expansionOrder: synsetCell ? expansionOrder : undefined,
    model: usesProductionEmbedder
      ? `${PRODUCTION_MODEL} (production embedder)`
      : model,
    cellModel: local?.meta.model,
    rankDepth: deep ? rankDepth : k,
    rerank: rerank || undefined,
    rerankModel: rerank ? rerankModel : undefined,
    rerankQuantized: rerank ? rerankQuantized : undefined,
    rerankInput: rerank ? rerankInput : undefined,
    rerankDepth: rerank ? rerankDepth : undefined,
    // `dbMs` means something DIFFERENT in a rerank run and the difference is
    // recorded rather than left to be discovered. A non-rerank Postgres run
    // times a `LIMIT k` query and issues the deep scan separately and untimed;
    // a rerank run issues ONE `LIMIT rankDepth` query and slices it, so its
    // `dbMs` is the deep query. Latency is not comparable across the two.
    dbTiming: rerank ? `single LIMIT ${rankDepth} query` : undefined,
    rows: rows.length,
    ranAt: new Date().toISOString(),
  };

  console.log(`Run "${tag}"`);
  for (const [key, value] of Object.entries(config)) {
    console.log(`  ${key.padEnd(12)} ${value}`);
  }

  // Warm the embedder BEFORE timing. ONNX cold start is seconds; letting it
  // land on query #1 would destroy the latency percentiles.
  process.stdout.write("\n  warming embedder... ");
  // `embed` is the production path from lib/embedder.ts and is used whenever the
  // production model is what we want — the harness must not have a second
  // implementation of the production encoder.
  const encode = usesProductionEmbedder ? embed : (t: string) => embedWith(model!, t);
  const warmStart = Date.now();
  await encode("warm up the model before any timing starts");
  console.log(`${Date.now() - warmStart}ms`);

  if (rerank) {
    // Same reason the embedder is warmed: ONNX session init is seconds, and
    // letting it land on query #1 destroys the latency percentiles.
    process.stdout.write(
      `  warming reranker ${rerankModel}${rerankQuantized ? " (int8)" : ""}... `
    );
    const rerankWarmStart = Date.now();
    await warmReranker(rerankModel, rerankQuantized);
    console.log(`${Date.now() - rerankWarmStart}ms`);
  }

  if (!local) {
    // Warm the DATABASE for the same reason, and one more besides. Neon
    // auto-suspends its compute, so the first query of a run pays several
    // seconds of wake-up: it lands on query #1 and wrecks the p50 exactly as an
    // ONNX cold start would (`prod_gloss_shipped.json` records dbMs=6606 on its
    // first row against a p50 of ~479). Worse, that wake-up can exceed Prisma's
    // default 2s interactive-transaction `maxWait` and abort the run outright
    // with "Transaction not found" before a single row is scored.
    //
    // Warmed through the SAME `search()` the run uses, not a bespoke `SELECT 1`
    // — connecting is only half of it; the IVFFlat probe pages want to be in
    // cache too, and a second retrieval path here would be the very thing this
    // harness refuses to have.
    process.stdout.write("  warming database... ");
    const dbWarmStart = Date.now();
    const warmVector = await encode("warm up the database before any timing starts");
    await search(prisma, warmVector, { k, probes, exact, filterJunk, index, perSense });
    console.log(`${Date.now() - dbWarmStart}ms`);
  }
  console.log("");

  const results: QueryResult[] = [];
  // The rerank depth sweep: a depth-D re-sort is a prefix of the depth-100
  // cross-encoder scores, so every shallower depth is scored from the SAME
  // forward passes rather than from another run. That is what makes RD-12's
  // "sweep the shortlist depth the way GLOSS_PROBES was swept" cost one run.
  const sweepResults = new Map<number, QueryResult[]>(
    rerankSweep.map((depth) => [depth, [] as QueryResult[]])
  );
  // Full shortlists including gloss text, written beside the run. Kept out of
  // the run JSON itself so a committed reference run stays a reviewable size.
  const shortlistRows: unknown[] = [];
  let done = 0;

  for (const row of rows) {
    const t0 = Date.now();
    const raw = await encode(row.query);
    const embedMs = Date.now() - t0;

    // A quantized or truncated cell needs the query put into the same space —
    // a halfvec column casts the query too, so applying the rounding to the
    // documents alone would flatter the result. No-op for a plain fp32 cell.
    const vector = local ? prepareQuery(local.meta, raw) : raw;

    const runSearch = (depth: number) =>
      local
        ? Promise.resolve(searchLocal(local, vector, { k: depth, perSense }))
        : search(prisma, vector, { k: depth, probes, exact, filterJunk, index, perSense });

    // The deep scan finds the target's true rank. It answers whether a wider
    // reranker could ever help: a target at rank 40 is recoverable, one at rank
    // 5,000 is not.
    let top: ResultRow[];
    let ranked: ResultRow[];
    let dbMs: number;
    let rerankMs: number | undefined;
    let shortlist: ShortlistEntry[] | undefined;
    const sweepRanked = new Map<number, ResultRow[]>();

    if (local) {
      // ONE exhaustive scan serves both depths. The scan is exact and
      // deterministic, so the top-k is literally a prefix of the top-`depth`.
      // Scanning twice would double the cost of a full-scale gloss cell —
      // 204,549 rows x 384 dims is ~79M multiply-adds per scan — to recompute
      // an answer already in hand. Latency from a local cell is meaningless
      // anyway; the report suppresses it.
      const depth = deep ? rankDepth : k;
      const t1 = Date.now();
      ranked = synsetCell
        ? searchLocalSynsets(local, vector, depth, expand)
        : searchLocal(local, vector, { k: depth, perSense });
      dbMs = Date.now() - t1;
      top = ranked.slice(0, k);
    } else if (rerank) {
      // ONE deep query, then slice — not the two-query shape below. The
      // cross-encoder needs the shortlist AND its gloss text, and a separate
      // shallow query for `top` would rerank a list the deep query had already
      // ordered differently. Consequence, recorded in the run config: `dbMs`
      // here is the depth-`rankDepth` query, so it is not comparable to a
      // non-rerank run's `dbMs`.
      const t1 = Date.now();
      const hits = (await searchGlossSynsets(
        prisma,
        `[${vector.join(",")}]`,
        rankDepth,
        probes,
        { withGloss: true }
      )) as GlossSynsetHit[];
      dbMs = Date.now() - t1;

      const t2 = Date.now();
      const scores = await scorePairs(
        rerankModel,
        row.query,
        hits.slice(0, rerankDepth).map((hit) => rerankText(rerankInput, hit)),
        { quantized: rerankQuantized }
      );
      rerankMs = Date.now() - t2;

      // Rerank the SYNSETS, then expand. Doing it the other way round would let
      // expandSynsets() dedupe and truncate first, so the cross-encoder would
      // reorder a list that had already thrown away its tail.
      //
      // NOTE: each word still inherits its synset's COSINE, so the run's
      // `similarities` are no longer descending — order now carries the
      // cross-encoder's judgement while the number carries retrieval's. Fine
      // offline, where only order is scored. It is not fine in the serving
      // path, which renders that number to users as a percentage; RD-13 has to
      // decide what the field means before any of this reaches a page.
      ranked = expandSynsets(rerankOrder(hits, scores, rerankDepth), rankDepth);
      top = ranked.slice(0, k);

      shortlist = hits.map((hit, i) => ({
        synsetKey: hit.synsetKey,
        sim: hit.similarity,
        ce: i < scores.length ? scores[i] : undefined,
      }));
      shortlistRows.push({
        id: row.id,
        query: row.query,
        target: row.target,
        candidates: hits.map((hit, i) => ({
          synsetKey: hit.synsetKey,
          gloss: hit.gloss,
          lemmas: hit.lemmas,
          sim: hit.similarity,
          ce: i < scores.length ? scores[i] : undefined,
        })),
      });

      for (const depth of rerankSweep) {
        sweepRanked.set(depth, expandSynsets(rerankOrder(hits, scores, depth), rankDepth));
      }
    } else {
      // Against Postgres the two are genuinely different queries (LIMIT k vs
      // LIMIT depth), so the deep scan stays separate and untimed — it must not
      // contaminate the latency figures.
      const t1 = Date.now();
      top = await runSearch(k);
      dbMs = Date.now() - t1;
      ranked = deep ? await runSearch(rankDepth) : top;
    }

    results.push({ ...measure(row, top, ranked, embedMs, dbMs), rerankMs, shortlist });

    for (const [depth, alt] of sweepRanked) {
      sweepResults.get(depth)!.push(measure(row, alt.slice(0, k), alt, embedMs, dbMs));
    }

    if (++done % 25 === 0) process.stdout.write(`\r  scored ${done}/${rows.length}`);
  }
  console.log(`\r  scored ${done}/${rows.length}\n`);

  // ------------------------------------------------------------- headline
  const reachable = results.filter((r) => r.meta.reachable !== false);
  const authored = reachable.filter((r) => r.source === "authored");
  const tripwire = results.filter((r) => r.source === "gloss_tripwire");
  const unreachable = results.filter((r) => r.meta.reachable === false);

  console.log("=".repeat(78));
  console.log(`HEADLINE — ${tag}`);
  console.log("=".repeat(78));
  console.log(METRICS_HEADER);
  if (authored.length) console.log(metricsLine("authored (reachable)", score(authored)));
  if (authored.length) {
    const noOverlap = authored.filter((r) => (r.meta.lexical_overlap ?? "none") === "none");
    console.log(metricsLine("  ... overlap=none", score(noOverlap)));
    const overlap = authored.filter((r) => (r.meta.lexical_overlap ?? "none") !== "none");
    if (overlap.length) console.log(metricsLine("  ... overlap!=none", score(overlap)));
  }
  if (tripwire.length) {
    console.log(metricsLine("gloss_tripwire", score(tripwire)));
    console.log(
      `  ^ leakage=paraphrase. Regression detector only — never a headline number.`
    );
  }
  if (unreachable.length) {
    const found = unreachable.filter((r) => r.rank !== null).length;
    console.log(
      `\n  coverage slice: ${unreachable.length} targets absent from the vocabulary; ` +
        `${found} unexpectedly retrieved`
    );
  }

  // --------------------------------------------------------------- slices
  const scopeForSlices = authored.length ? authored : reachable;
  reportSlices("source", results, (r) => r.source);
  reportSlices("style", scopeForSlices, (r) => r.meta.style as string | undefined);
  reportSlices("query length", scopeForSlices, (r) => lengthBucket(r.query));
  reportSlices("token count", scopeForSlices, (r) => r.meta.token_count as string | undefined);
  reportSlices("lexical overlap", scopeForSlices, (r) => (r.meta.lexical_overlap as string) ?? "none");
  reportSlices(
    bands === 3 ? "frequency band (terciles)" : "frequency band (fixed)",
    scopeForSlices,
    bandLabeller(scopeForSlices, bands)
  );

  // -------------------------------------------------------------- latency
  const totals = results.map((r) => r.embedMs + r.dbMs);
  console.log(`\n  latency (ms, embedder warmed before timing)`);
  console.log(
    `    total  p50 ${percentile(totals, 50).toFixed(0)}   p95 ${percentile(totals, 95).toFixed(0)}`
  );
  console.log(
    `    embed  p50 ${percentile(results.map((r) => r.embedMs), 50).toFixed(0)}   ` +
      `p95 ${percentile(results.map((r) => r.embedMs), 95).toFixed(0)}`
  );
  console.log(
    `    db     p50 ${percentile(results.map((r) => r.dbMs), 50).toFixed(0)}   ` +
      `p95 ${percentile(results.map((r) => r.dbMs), 95).toFixed(0)}`
  );

  // ------------------------------------------------------ the decisive gap
  const head = score(authored.length ? authored : reachable);
  const gap = head.recall10 - head.recall1;
  console.log(`\n  R@10 - R@1 = ${fmtPct(gap)}`);
  console.log(
    `    That gap is the ceiling on what a perfect reranker over the top 10 could add.\n` +
      `    Large gap -> the next win is reranking. Small gap with low R@10 -> the answer\n` +
      `    is not being retrieved at all, and the work is re-encoding, not reordering.`
  );
  if (deep) {
    const beyond = head.beyond10;
    console.log(
      `\n  targets found beyond rank 10 but within ${rankDepth}: ${fmtPct(beyond)}\n` +
        `    This is the headroom a WIDER reranker would have. If it is near zero, no\n` +
        `    reranking depth helps and the representation is the only lever.`
    );
  }

  if (deep && head.n > 0) {
    console.log(`\n  recall by depth (${authored.length ? "authored reachable" : "reachable"}, n=${head.n})`);
    for (const line of recallLadder(authored.length ? authored : reachable, rankDepth)) {
      console.log(line);
    }
    console.log(
      `    ^ a perfect reranker over a D-deep shortlist lands lenient R@1 at the depth-D\n` +
        `      figure. The complement of the deepest column is never retrieved at all and is\n` +
        `      unreachable by reordering at any depth — that slice needs a better representation.`
    );
  }

  // ------------------------------------------------------- rerank depth sweep
  if (rerank && sweepResults.size > 0) {
    console.log(`\n  rerank depth sweep (${rerankModel}${rerankQuantized ? ", int8" : ""}, input=${rerankInput})`);
    console.log(METRICS_HEADER);
    const scopeOf = (rs: QueryResult[]) => {
      const reach = rs.filter((r) => r.meta.reachable !== false);
      const auth = reach.filter((r) => r.source === "authored");
      return auth.length ? auth : reach;
    };
    for (const depth of [...sweepResults.keys()].sort((a, b) => a - b)) {
      console.log(metricsLine(`depth ${depth}`, score(scopeOf(sweepResults.get(depth)!))));
    }
    console.log(metricsLine(`depth ${rerankDepth} (headline)`, head));
    console.log(
      `    Every row above is scored from the SAME cross-encoder forward passes — a\n` +
        `    depth-D re-sort is a prefix of the depth-${rerankDepth} scores, so the sweep is free.`
    );
  }

  if (rerank) {
    // Carried the way PREREGISTERED_NOTE is: attached to the numbers rather
    // than filed somewhere a future run would have to go looking for.
    console.log(`\n  ${RERANK_FINDING}`);
  }

  console.log(`\n  ${PREREGISTERED_NOTE}`);

  // ----------------------------------------------------------------- save
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const outPath = path.join(RUNS_DIR, `${tag}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        tag,
        config,
        preregistered: PREREGISTERED_NOTE,
        ...(rerank ? { rerankFinding: RERANK_FINDING } : {}),
        results,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`\n  wrote ${path.relative(process.cwd(), outPath)}`);

  if (shortlistRows.length) {
    // Sidecar, not inlined: gloss text for 100 candidates x 405 rows would
    // quadruple a committed reference run for detail only a re-scoring or an
    // audit ever reads. Gitignored; the run JSON keeps the compact form.
    const shortlistPath = path.join(RUNS_DIR, `${tag}.shortlist.jsonl`);
    fs.writeFileSync(
      shortlistPath,
      shortlistRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8"
    );
    console.log(`  wrote ${path.relative(process.cwd(), shortlistPath)}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const cmpIndex = process.argv.indexOf("--compare");
  if (cmpIndex !== -1) {
    compare(process.argv[cmpIndex + 1], process.argv[cmpIndex + 2]);
    return;
  }
  await run();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
