/**
 * The scoring harness.
 *
 * Runs the real search — measure the question, then ask the database — against
 * a fixed list of (description -> word) pairs. It calls the same search code
 * and the same measuring code the live site uses, rather than its own copies,
 * so the numbers describe production and not a lookalike.
 *
 *   npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --tag baseline
 *   npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --exact --tag exact
 *   npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --filter-junk --tag filtered
 *   npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --index EvalPoolGloss --per-sense --tag gloss
 *   npx tsx scripts/eval.ts --compare eval/runs/baseline.json eval/runs/gloss.json
 *
 * Flags:
 *   --k <n>            results per query for the headline metrics (default 10)
 *   --probes <n>       how hard to search (default 10, matching production)
 *   --exact            sequential scan — the true nearest-neighbour ceiling
 *   --filter-junk      restrict the pool with the Phase A junk predicate
 *   --index <table>    search an alternative index table in Postgres
 *   --index-file <cell> search a local file-backed index (the Phase E 2x2 cells;
 *                      exhaustive, so exact by construction)
 *   --per-sense        table has one row per (word, sense); dedupe by word
 *   --expansion-order <wordnet|zipf|index>
 *                      meaning-keyed files only: how to order the words a
 *                      retrieved meaning expands into.
 *                      `wordnet` (default) uses WordNet's own sense-familiarity
 *                      order; `zipf` guesses the commonest mate first; `index`
 *                      keeps stored order
 *   --model <id>       embedding model override (for the base-model control)
 *   --rank-depth <n>   how deep to look for the target (default 100)
 *   --no-deep          skip the deep scan (headline metrics only)
 *   --rerank           re-sort the retrieved shortlist with a second model
 *                      before scoring. Gloss index only.
 *   --rerank-depth <n> how many results the second model re-sorts (default 50)
 *   --rerank-model <id>  which model to re-sort with
 *   --rerank-quantized   load the smaller, faster weights
 *   --rerank-input <gloss|lemma-gloss>   (definition, or word plus definition)
 *                      what text the second model sees per candidate
 *   --rerank-sweep <a,b,c>
 *                      also report the metrics at these shallower depths.
 *                      Free: a shallow re-sort is a prefix of the deep one.
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
  vocabularyOf,
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
 * Prediction written down before the numbers were seen, so it cannot be
 * retrofitted: 258 stranded verbs out of 11,540 is far too small a share to
 * move a whole category. So if narrative questions score clearly worse than the
 * others, stranded verbs are almost certainly not the reason, and the finding
 * points back at how words are represented.
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

/** Fingerprint of the question set as it was when this run scored it. */
// The set never changes once built, so a run and its set are a matched pair
// forever. Recording the fingerprint is what makes an edit to it detectable.
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

/** How often the answer appears, looking further and further down the list. */
// Read it as the best a perfect re-sorter could do at each depth. Whatever is
// missing from the deepest column was never found at all, so no amount of
// re-sorting reaches it. Keeping those two apart is the whole point.
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

/** Fixed frequency bands, or even thirds when the fixed ones come out lopsided. */
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

    // Side by side: how much of the gap is work a re-sorter could do, and how
    // much is answers that were never found and so are out of its reach.
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

    /** Both measures get their own test, reported side by side and never merged. */
    // Scored on the headline questions only — the hand-written, answerable ones.
    // Including the rest would dilute the result and divide it by the wrong total,
    // so a verdict would not match the table printed beside it.
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
        // The gap between the two runs, which for a right/wrong outcome is exactly
        // wins minus losses, over the number of questions.
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
            // Stated outright rather than left to the reader's optimism: a gain below
            // the bar agreed in advance is a null result and is not to be acted on,
            // however convincing the statistics look.
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

    // The coverage questions, tested separately and on their own total.
    //
    // Deliberately outside the main test. These are questions no dictionary we had
    // could answer, so folding them in would mix "did ranking improve?" with "did
    // the word list grow?" — two questions whose answers can point opposite ways.
  const coverage = paired.filter((q) => q.ra.meta.reachable === false);
  if (coverage.length) {
    const found = (rows: QueryResult[]) => rows.filter((r) => r.lenientRank === 1).length;
    const a1 = found(coverage.map((q) => q.ra));
    const b1 = found(coverage.map((q) => q.rb));
    console.log(
      `\n  coverage slice (reachable:false, n=${coverage.length}) — reported separately, ` +
        `never folded into the numbers above`
    );
    console.log(`    ${a.tag}: ${a1} at rank 1     ${b.tag}: ${b1} at rank 1`);
    console.log(`${METRICS_HEADER}`);
    console.log(metricsLine(a.tag, score(coverage.map((q) => q.ra))));
    console.log(metricsLine(b.tag, score(coverage.map((q) => q.rb))));
  }
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

// ------------------------------------------- expanding meanings into words

type ExpansionOrder = "wordnet" | "zipf" | "index";

/**
 * How a retrieved meaning is unpacked into the words the answer key uses.
 *
 * Words sharing a meaning have identical numbers, so search genuinely cannot
 * tell them apart. This is therefore a policy, not a result — it has to be
 * chosen deliberately, and it must not be able to see the answer key.
 *
 *   wordnet  the dictionary's own order, most familiar sense first. Independent
 *            of this test, and the best of the three. The default.
 *   zipf     commonest word first. Reasonable in principle, worst in practice.
 *   index    stored order. For comparison only, never for production.
 */
function expansionOrderFn(kind: ExpansionOrder): ExpandOrder {
  if (kind === "index") return (_key, members) => members;

  if (kind === "zipf") {
    const zipf = loadZipf();
    const rank = (w: string) => zipf.get(w.toLowerCase()) ?? 0;
    return (_key, members) => [...members].sort((a, b) => rank(b) - rank(a));
  }

    // The dictionary's own ordering, read straight from its data files.
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
        // Anything the dictionary doesn't list keeps its place after everything it does.
    return [...members].sort(
      (a, b) =>
        (positions.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
    );
  };
}

// ------------------------------------------------------------ scoring a row

/** Score one question's results. */
// Shared with the depth sweep on purpose. Two scoring implementations would let
// a sweep table disagree with the run printed beside it, for reasons nobody
// could find.
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

/** Re-sort the first few results with the second model, leaving the rest alone. */
// The tail is kept because the answer's true position is measured much deeper
// than the part being re-sorted; dropping it would silently shorten the
// measurement. It is also what a real re-sorting step would do.
//
// Ties fall back to search order, spelled out rather than left to whichever
// sort the language happens to use. A tie rule has to be a decision on the
// page: an earlier one quietly encoded the answer key.
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

/** Which dictionaries a live index holds — asked, not assumed. */
// Guessing from the table's name is exactly the kind of label that goes stale
// after a migration, and the failure would be silent: two runs over genuinely
// different word lists, tabled side by side as if their scores meant the same.
async function postgresVocabulary(
  index: string
): Promise<"wordnet" | "wordnet+wiktionary" | undefined> {
  if (index !== GLOSS_INDEX) return undefined;
  try {
    const [row] = await prisma.$queryRawUnsafe<{ has: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM "${GLOSS_INDEX}" WHERE "synsetKey" LIKE 'wikt:%') AS has`
    );
    return row?.has ? "wordnet+wiktionary" : "wordnet";
  } catch {
        // A check that cannot run must not take the whole run down with it — this is
        // a record of what was used, not a measurement.
    return undefined;
  }
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
    // Left unset unless asked for, so each index uses its own setting rather than
    // having another index's imposed on it. Recorded below as the value actually
    // used, never as a guess.
  const probes = has("--probes") ? numArg("--probes", PRODUCTION_PROBES) : undefined;
  const effectiveProbes = probes ?? (index === GLOSS_INDEX ? GLOSS_PROBES : PRODUCTION_PROBES);
  const indexFile = arg("--index-file");
  const perSense = has("--per-sense");

    // Experiments live in local files rather than the database. Searching a file
    // checks every row, so those runs carry no index shortcuts at all.
  let local: LocalIndex | undefined;
  if (indexFile) {
    local = loadIndex(indexFile);
    console.log(
      `  local index   ${local.meta.cell}: ${local.meta.rows.toLocaleString()} rows, ` +
        `${local.meta.distinctWords.toLocaleString()} distinct words, model ${local.meta.model}`
    );
  }
    // A meaning-keyed experiment stores one row per meaning and has to be expanded
    // into words before it can be scored against a word-level answer key.
  const synsetCell = local?.meta.variant === "gloss_synset";
    // Words sharing a meaning have identical numbers, so which one comes first is
    // purely a tie-break, not a result. Each option below is a deliberate policy.
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

    // The model measuring the questions MUST be the one the experiment was built
    // with. Getting it wrong is silent and fatal: it compares numbers from two
    // different scales, and every result that comes out is meaningless while
    // reading like a real finding.
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

  // -------------------------------------------------------------- re-sorting
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
        // Refuse rather than quietly ignore: a run labelled as re-sorted that never
        // re-sorted anything would put a false claim in a saved result file, and
        // nobody would ever catch it.
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

    // Each question already carries a word-frequency figure; this flag swaps in a
    // different source without rebuilding the set.
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
        // Experiments of different sizes are not comparable. Recorded per run so a
        // mismatched comparison gets flagged rather than tabled as if it were fair.
    poolScale: local ? scaleOf(local.meta) : undefined,
        // Which dictionaries the candidates came from — tracked apart from size,
        // because two experiments can be the same size and still hold different
        // candidates, which makes their scores just as incomparable.
    vocabulary: local ? vocabularyOf(local.meta) : await postgresVocabulary(index),
    supplementArm: local?.meta.supplementArm,
    filterVersion: local?.meta.filterVersion,
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
        // Database timings mean something different in a re-sorting run, so which
        // kind this was is recorded rather than left to be discovered later. The two
        // are not comparable.
    dbTiming: rerank ? `single LIMIT ${rankDepth} query` : undefined,
    rows: rows.length,
    ranAt: new Date().toISOString(),
  };

  console.log(`Run "${tag}"`);
  for (const [key, value] of Object.entries(config)) {
    console.log(`  ${key.padEnd(12)} ${value}`);
  }

    // Load the model before timing starts. Its first use takes seconds, and
    // letting that land on question one would wreck the timing figures.
    //
    // This is the live site's own measuring code, deliberately — the harness must
    // not carry a second copy of it.
  process.stdout.write("\n  warming embedder... ");
  // `embed` is the production path from lib/embedder.ts and is used whenever the
  // production model is what we want — the harness must not have a second
  // implementation of the production encoder.
  const encode = usesProductionEmbedder ? embed : (t: string) => embedWith(model!, t);
  const warmStart = Date.now();
  await encode("warm up the model before any timing starts");
  console.log(`${Date.now() - warmStart}ms`);

  if (rerank) {
        // Same reason as above: the first use takes seconds, and letting it land on
        // question one would wreck the timing figures.
    process.stdout.write(
      `  warming reranker ${rerankModel}${rerankQuantized ? " (int8)" : ""}... `
    );
    const rerankWarmStart = Date.now();
    await warmReranker(rerankModel, rerankQuantized);
    console.log(`${Date.now() - rerankWarmStart}ms`);
  }

  if (!local) {
        // Wake the database up first, for the same reason and one more besides. It
        // goes to sleep when idle, so the first query pays several seconds — enough
        // to wreck the timings, and sometimes enough to abort the whole run before a
        // single question is scored.
        //
        // Warmed through the very same search the run uses, not a token query:
        // connecting is only half of it, and a second search path here is exactly
        // what this harness refuses to have.
    process.stdout.write("  warming database... ");
    const dbWarmStart = Date.now();
    const warmVector = await encode("warm up the database before any timing starts");
    await search(prisma, warmVector, { k, probes, exact, filterJunk, index, perSense });
    console.log(`${Date.now() - dbWarmStart}ms`);
  }
  console.log("");

  const results: QueryResult[] = [];
    // Sweeping the depth is free: a shallow re-sort is just the front of a deep
    // one, so every depth is scored from the same work rather than another run.
  const sweepResults = new Map<number, QueryResult[]>(
    rerankSweep.map((depth) => [depth, [] as QueryResult[]])
  );
    // The full shortlists, written to a file beside the run rather than inside it,
    // so a saved reference run stays a reviewable size.
  const shortlistRows: unknown[] = [];
  let done = 0;

  for (const row of rows) {
    const t0 = Date.now();
    const raw = await encode(row.query);
    const embedMs = Date.now() - t0;

        // A rounded or shortened experiment needs the question given the same
        // treatment, or the cost of doing it looks smaller than it is. Does nothing
        // for a plain, full-precision experiment.
    const vector = local ? prepareQuery(local.meta, raw) : raw;

    const runSearch = (depth: number) =>
      local
        ? Promise.resolve(searchLocal(local, vector, { k: depth, perSense }))
        : search(prisma, vector, { k: depth, probes, exact, filterJunk, index, perSense });

        // Look deep to find where the right answer really came. That answers whether
        // re-sorting could ever help: position 40 is recoverable, position 5,000
        // is not.
    let top: ResultRow[];
    let ranked: ResultRow[];
    let dbMs: number;
    let rerankMs: number | undefined;
    let shortlist: ShortlistEntry[] | undefined;
    const sweepRanked = new Map<number, ResultRow[]>();

    if (local) {
            // One pass serves both depths: the scan is exact and repeatable, so the
            // short list is literally the front of the long one. Scanning twice would
            // double the cost to recompute an answer already in hand.
      const depth = deep ? rankDepth : k;
      const t1 = Date.now();
      ranked = synsetCell
        ? searchLocalSynsets(local, vector, depth, expand)
        : searchLocal(local, vector, { k: depth, perSense });
      dbMs = Date.now() - t1;
      top = ranked.slice(0, k);
    } else if (rerank) {
            // One deep query, then slice it — not two separate queries. The second
            // model needs the whole shortlist and its definitions, and a separate
            // shallow query would re-sort a differently ordered list.
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

            // Re-sort the meanings, then expand into words. The other way round would
            // throw away the tail before the second model ever saw it.
            //
            // Note that each word keeps its original score, so the saved scores no
            // longer fall in order: the order now carries the second model's opinion
            // while the number carries the first's. Fine offline, where only order is
            // scored. Not fine on a page that shows that number to a user.
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
            // Against the database these really are two different queries, so the deep
            // one stays separate and untimed and cannot pollute the timing figures.
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
      `\n  coverage slice: ${unreachable.length} targets flagged absent from the vocabulary; ` +
        `${found} retrieved within rank depth`
    );
        // Scored properly, not just counted. A bare count cannot say whether a
        // newly added word actually ranks, which is the whole question — a word
        // that is present but never surfaces has not really been added.
        //
        // Reported here beside the headline and never folded into it. The headline
        // set is fixed, so adding words cannot quietly move its denominator. That is
        // what keeps the comparison honest.
    console.log(METRICS_HEADER);
    console.log(metricsLine("coverage (unreachable)", score(unreachable)));
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
        // Attached to the numbers themselves, rather than filed somewhere a future
        // run would have to go looking for it.
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
        // Written to its own file, not inlined: the definitions for every candidate
        // would bloat a saved reference run several times over, for detail only a
        // re-scoring or an audit ever reads.
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
