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
import { score, percentile, mcnemar, type QueryResult, type Metrics } from "./lib/metrics";
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

  const top1 = (r: QueryResult) => r.rank === 1;
  const regressions = paired.filter((p) => top1(p.ra) && !top1(p.rb));
  const wins = paired.filter((p) => !top1(p.ra) && top1(p.rb));
  const { p, n } = mcnemar(regressions.length, wins.length);

  console.log(`\n  McNemar on rank-1 disagreements (exact, two-sided)`);
  console.log(`    ${a.tag} right / ${b.tag} wrong : ${regressions.length}`);
  console.log(`    ${a.tag} wrong / ${b.tag} right : ${wins.length}`);
  console.log(`    discordant pairs n = ${n}   p = ${p.toFixed(5)}`);
  console.log(
    `    ${p < 0.05 ? "SIGNIFICANT at 0.05" : "not significant at 0.05"}` +
      ` — the ${paired.length - n} queries both runs agree on carry no information here.`
  );

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
  const probes = numArg("--probes", PRODUCTION_PROBES);
  const exact = has("--exact");
  const filterJunk = has("--filter-junk");
  const index = arg("--index") ?? DEFAULT_INDEX;
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
    probes: exact ? null : probes,
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
  console.log(`${Date.now() - warmStart}ms\n`);

  const results: QueryResult[] = [];
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
    } else {
      // Against Postgres the two are genuinely different queries (LIMIT k vs
      // LIMIT depth), so the deep scan stays separate and untimed — it must not
      // contaminate the latency figures.
      const t1 = Date.now();
      top = await runSearch(k);
      dbMs = Date.now() - t1;
      ranked = deep ? await runSearch(rankDepth) : top;
    }

    const words = ranked.map((r) => r.word);
    const lowered = words.map(norm);
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

    results.push({
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
    });

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

  console.log(`\n  ${PREREGISTERED_NOTE}`);

  // ----------------------------------------------------------------- save
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const outPath = path.join(RUNS_DIR, `${tag}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify({ tag, config, preregistered: PREREGISTERED_NOTE, results }, null, 2),
    "utf8"
  );
  console.log(`\n  wrote ${path.relative(process.cwd(), outPath)}\n`);
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
