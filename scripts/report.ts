/**
 * Generate `eval/REPORT.md` from whatever is in `eval/runs/`.
 *
 * WHY THIS IS A GENERATOR AND NOT A DOCUMENT. A hand-written results file is
 * wrong the moment anything reruns, and this one will rerun a dozen times. Every
 * number in the report traces to a `eval/runs/*.json` written by `eval.ts`; if a
 * figure is wrong here, it is wrong in this generator or in the run, never in the
 * markdown. `eval/REPORT.md` must never be edited by hand.
 *
 * The reasoning behind the benchmark lives in `eval/METHODS.md`, which IS
 * hand-written and does not change when the numbers do. The two are meant to be
 * read together: methods explain why a number means anything, this explains what
 * the number is.
 *
 * Rules this file enforces so the report cannot mislead:
 *   - the authored slice is the only headline; `gloss_tripwire` is tabled
 *     separately, labelled leaked, and never mixed in
 *   - the set's sha256 is printed beside the numbers, and a run scored against a
 *     different version of its set is called out loudly
 *   - comparisons are paired (McNemar), so a non-significant difference reads as
 *     non-significant rather than as a win
 *   - the pre-registered prediction is printed directly above the style slice,
 *     and the pre-committed decision rule directly above the comparison table
 *   - cells built from different pools are marked cross-scale, not tabled as
 *     though their numbers meant the same thing
 *   - the two retrieval implementations are cross-validated against each other
 *     whenever the runs to do it exist
 *   - latency is always accompanied by the note that it is not production latency
 *
 *   npx tsx scripts/report.ts
 *   npx tsx scripts/report.ts --out /tmp/preview.md --runs eval/runs
 *   npx tsx scripts/report.ts --pair baseline:gloss_ft --pair baseline:exact
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { score, percentile, mcnemar, type QueryResult, type Metrics } from "./lib/metrics";
import type { EvalRow } from "./build-eval-set";

const DEFAULT_RUNS = "eval/runs";
const DEFAULT_OUT = "eval/REPORT.md";

const DASH = "—";

/**
 * Pre-committed before any Phase E number existed. `eval/METHODS.md` §9a.
 *
 * Printed directly above the comparison table rather than filed in the methods
 * document, because the moment it is needed is the moment a small delta is on
 * screen and the reading of it is being decided.
 */
const DECISION_RULE_HEADING = "Pre-committed decision rule — recorded before the data";
const DECISION_RULE = [
  "**A gloss cell beating the lemma baseline by fewer than ~6 points of LENIENT Recall@1",
  "is a null result, not a win.** Lenient R@1 is rank-1 scored against the hand-authored",
  "`acceptable[]` list. At n ≈ 289 the paired test cannot distinguish smaller differences",
  "from noise — a synthetic run through this same code produced a 5.7-point delta at",
  "p = 0.51 on 37 discordant pairs. The effect size that would justify a representation",
  "change is the scale of the register gap already measured (62.4% against ~19%, i.e. tens",
  "of points), not single digits. **A small positive result is to be reported as a null",
  "result and not acted on.**",
  "",
  "Recorded 2026-08-19; metric amended the same day, before any Phase E number existed,",
  "from strict R@1 to lenient R@1. Strict R@1 is still reported below and is **tie-deflated",
  "for gloss cells** — synset-mates share one gloss, so their vectors are identical and",
  "rank 1 among them is an arbitrary tie-break on 76% of the benchmark. Full reasoning and",
  "both wordings: `eval/METHODS.md` §9a.",
];

/**
 * The pre-committed rule in one place (METHODS §9a): a delta below the
 * threshold is a null result even when it is positive, and even when the paired
 * test happens to reach significance. Rendered by the generator so the verdict
 * cannot drift from the rule through someone's optimistic reading.
 */
const DECISION_THRESHOLD = 0.06;

function verdict(delta: number, p: number): string {
  if (delta >= DECISION_THRESHOLD && p < 0.05) return "**WIN (§9a)**";
  if (delta >= DECISION_THRESHOLD) return "above threshold, not significant";
  if (delta > 0) return "**null result** (below ~6 pts)";
  if (p < 0.05) return "**significant regression**";
  return "no difference";
}

type RunConfig = {
  set: string;
  setSha256?: string | null;
  k: number;
  probes: number | null;
  exact: boolean;
  filterJunk: boolean;
  index: string;
  perSense: boolean;
  exactByConstruction?: boolean;
  poolScope?: string;
  poolScale?: "sampled" | "full";
  /** RD-17: which dictionary the candidate set came from. */
  vocabulary?: "wordnet" | "wordnet+wiktionary";
  supplementArm?: string;
  filterVersion?: string;
  poolWords?: number;
  cellVariant?: string;
  /** Synset cells only: how a retrieved synset was expanded into member words. */
  expansionOrder?: string;
  cellPrecision?: string;
  cellDim?: number;
  model: string;
  rankDepth: number;
  /** RD-12: a cross-encoder re-sorted the shortlist before scoring. */
  rerank?: boolean;
  rerankModel?: string;
  rerankQuantized?: boolean;
  rerankInput?: string;
  rerankDepth?: number;
  /** What `dbMs` measured — a rerank run times one deep query, not a LIMIT k one. */
  dbTiming?: string;
  rows: number;
  ranAt: string;
};

type Run = {
  file: string;
  tag: string;
  config: RunConfig;
  preregistered?: string;
  results: QueryResult[];
};

// ------------------------------------------------------------------ argv

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function argAll(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

// -------------------------------------------------------------- loading

function loadRuns(dir: string): Run[] {
  const full = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(full, f), "utf8")) as Run;
      return { ...parsed, file: path.join(dir, f).replace(/\\/g, "/") };
    })
    .filter((r) => Array.isArray(r.results) && r.config)
    .sort((a, b) => a.config.ranAt.localeCompare(b.config.ranAt));
}

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

function readSet(file: string): EvalRow[] | null {
  try {
    return fs
      .readFileSync(path.resolve(process.cwd(), file), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EvalRow);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- scoring

/**
 * `score()` from lib/metrics is the shared source of truth; this adds only the
 * lenient R@3, which the report shows and the console harness does not. Derived
 * from the same `lenientRank` field, not recomputed from scratch.
 */
type FullMetrics = Metrics & { lenientRecall3: number };

function scoreFull(rows: QueryResult[]): FullMetrics {
  const base = score(rows);
  const lenientRecall3 =
    rows.length === 0
      ? NaN
      : rows.filter((r) => r.lenientRank !== null && r.lenientRank <= 3).length / rows.length;
  return { ...base, lenientRecall3 };
}

const authoredOf = (r: Run) =>
  r.results.filter((q) => q.source === "authored" && q.meta.reachable !== false);
const tripwireOf = (r: Run) => r.results.filter((q) => q.source === "gloss_tripwire");
const unreachableOf = (r: Run) => r.results.filter((q) => q.meta.reachable === false);

/** The slice scope: authored where it exists, everything reachable otherwise. */
function sliceScope(r: Run): QueryResult[] {
  const authored = authoredOf(r);
  return authored.length ? authored : r.results.filter((q) => q.meta.reachable !== false);
}

// ------------------------------------------------------------ formatting

function pct(n: number): string {
  return Number.isNaN(n) ? DASH : `${(n * 100).toFixed(1)}%`;
}

function num(n: number, digits = 3): string {
  return Number.isNaN(n) ? DASH : n.toFixed(digits);
}

function table(header: string[], rows: string[][]): string {
  const sep = header.map(() => "---");
  return [header, sep, ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

const METRIC_HEADER = [
  "n",
  "R@1",
  "R@3",
  "R@10",
  "MRR@10",
  "len R@1",
  "len R@3",
  "len R@10",
  "echo",
];

function metricCells(m: FullMetrics): string[] {
  return [
    String(m.n),
    pct(m.recall1),
    pct(m.recall3),
    pct(m.recall10),
    num(m.mrr10),
    pct(m.lenientRecall1),
    pct(m.lenientRecall3),
    pct(m.lenientRecall10),
    pct(m.echoRate),
  ];
}

function lengthBucket(query: string): string {
  const n = query.trim().split(/\s+/).length;
  if (n <= 8) return "<=8 words";
  if (n <= 12) return "9-12 words";
  if (n <= 16) return "13-16 words";
  return "17+ words";
}

/**
 * Fixed Zipf bands, mirroring `lib/freq.ts`. Duplicated as a labeller rather
 * than imported wholesale because the report only ever needs the fixed bands —
 * data-driven terciles depend on the run's own distribution, which would make
 * two runs' band columns mean different things.
 */
function bandOfZipf(z: unknown): string {
  if (typeof z !== "number") return "unknown";
  if (z >= 5) return "very_common (>=5)";
  if (z >= 4) return "common (4-5)";
  if (z >= 3) return "mid (3-4)";
  if (z >= 2) return "uncommon (2-3)";
  return "rare (<2)";
}

function sliceTable(
  rows: QueryResult[],
  key: (r: QueryResult) => string | undefined
): string | null {
  const groups = new Map<string, QueryResult[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  if (groups.size === 0) return null;
  const body = [...groups]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, rs]) => [k, ...metricCells(scoreFull(rs))]);
  return table(["slice", ...METRIC_HEADER], body);
}

// ------------------------------------------------------------- sections

function setIdentitySection(runs: Run[]): string {
  const out: string[] = ["## 1. Frozen set identity", ""];
  out.push(
    "The set is frozen once built — a new version means a new filename, never an",
    "in-place regeneration. The hash recorded in each run is compared against the",
    "file on disk below; a mismatch means the numbers were scored against a",
    "different set than the one now present, and nothing in this report can be",
    "trusted until it is resolved.",
    ""
  );

  const bySet = new Map<string, Run[]>();
  for (const r of runs) {
    if (!bySet.has(r.config.set)) bySet.set(r.config.set, []);
    bySet.get(r.config.set)!.push(r);
  }

  for (const [setFile, group] of bySet) {
    const onDisk = sha256File(setFile);
    const recorded = group.map((r) => r.config.setSha256).filter(Boolean) as string[];
    const distinct = [...new Set(recorded)];

    out.push(`### \`${setFile}\``, "");

    const idRows: string[][] = [];
    idRows.push(["sha256 on disk", onDisk ? `\`${onDisk}\`` : "*file not found*"]);
    if (distinct.length === 0) {
      idRows.push([
        "sha256 recorded in runs",
        "*not recorded* — these runs predate hash recording; identity is unverified",
      ]);
    } else if (distinct.length === 1) {
      const match = onDisk === null ? "cannot check" : distinct[0] === onDisk ? "MATCHES" : "**MISMATCH**";
      idRows.push(["sha256 recorded in runs", `\`${distinct[0]}\` — ${match}`]);
    } else {
      idRows.push([
        "sha256 recorded in runs",
        `**${distinct.length} DIFFERENT HASHES** across runs — the set changed underneath them: ` +
          distinct.map((d) => `\`${d.slice(0, 12)}…\``).join(", "),
      ]);
    }
    idRows.push(["runs against it", group.map((r) => `\`${r.tag}\``).join(", ")]);
    out.push(table(["field", "value"], idRows), "");

    if (distinct.length > 1 || (distinct.length === 1 && onDisk && distinct[0] !== onDisk)) {
      out.push(
        "> **Integrity failure.** At least one run was scored against a different version",
        "> of this file. Rebuild under a new filename and rerun; do not reconcile by editing.",
        ""
      );
    }

    // Pair counts: from the set file where it still exists (authoritative),
    // otherwise reconstructed from the run that scored the most rows.
    const rowsFromFile = readSet(setFile);
    const counted: { label: string; get: (r: EvalRow | QueryResult) => string }[] = [
      { label: "source", get: (r) => (r as EvalRow).source },
      {
        label: "reachable",
        get: (r) => ((r.meta as Record<string, unknown>).reachable === false ? "false" : "true"),
      },
      {
        label: "lexical_overlap",
        get: (r) => ((r.meta as Record<string, unknown>).lexical_overlap as string) ?? "none",
      },
      {
        label: "style",
        get: (r) => ((r.meta as Record<string, unknown>).style as string) ?? "(none)",
      },
      {
        label: "token_count",
        get: (r) => ((r.meta as Record<string, unknown>).token_count as string) ?? "(none)",
      },
      {
        label: "leakage",
        get: (r) => ((r.meta as Record<string, unknown>).leakage as string) ?? "none",
      },
    ];

    const source: (EvalRow | QueryResult)[] =
      rowsFromFile ?? group.slice().sort((a, b) => b.results.length - a.results.length)[0].results;

    out.push(
      `Pair counts (${rowsFromFile ? "from the set file" : "reconstructed from run results — set file missing"}): ` +
        `**${source.length} rows**`,
      ""
    );
    const countRows: string[][] = [];
    for (const dim of counted) {
      const tally = new Map<string, number>();
      for (const r of source) {
        const v = dim.get(r);
        tally.set(v, (tally.get(v) ?? 0) + 1);
      }
      const cells = [...tally]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");
      countRows.push([dim.label, cells]);
    }
    out.push(table(["dimension", "counts"], countRows), "");
  }

  return out.join("\n");
}

function headlineSection(runs: Run[]): string {
  const withAuthored = runs.filter((r) => authoredOf(r).length > 0);
  const out: string[] = ["## 2. Headline — authored slice", ""];

  if (withAuthored.length === 0) {
    out.push(
      "> **No authored results exist yet.** Every run present was scored against the",
      "> quarantined `gloss_tripwire` slice only. Nothing in this report is a baseline,",
      "> and no number here describes how the system performs on hand-written queries.",
      "> See §3 and `eval/METHODS.md` §4 for why the two are not interchangeable.",
      ""
    );
    return out.join("\n");
  }

  out.push(
    "Blind hand-authored queries, reachable targets only. **This is the only headline.**",
    "Strict metrics score the target itself; lenient metrics accept anything in",
    "`meta.acceptable[]`. Echo rate is the share of top-10 results sharing a stem with a",
    "query content word — it is a primary metric, not a diagnostic: a change that moves",
    "recall without moving echo needs explaining.",
    ""
  );
  out.push(
    table(
      ["run", ...METRIC_HEADER],
      withAuthored.map((r) => [`\`${r.tag}\``, ...metricCells(scoreFull(authoredOf(r)))])
    ),
    ""
  );

  out.push(
    "Lexical-overlap rows are kept in the set on purpose (a person asking about a bowler",
    "hat says \"hat\"), so recall is reported both including and excluding them.",
    ""
  );
  const noOverlap = withAuthored.map((r) => [
    `\`${r.tag}\``,
    ...metricCells(
      scoreFull(authoredOf(r).filter((q) => (q.meta.lexical_overlap ?? "none") === "none"))
    ),
  ]);
  out.push("**Excluding every lexical-overlap row:**", "", table(["run", ...METRIC_HEADER], noOverlap), "");

  return out.join("\n");
}

function tripwireSection(runs: Run[]): string {
  const withTripwire = runs.filter((r) => tripwireOf(r).length > 0);
  if (withTripwire.length === 0) return "";

  const out: string[] = ["## 3. Quarantined slice — `gloss_tripwire`", ""];
  out.push(
    "> **LEAKED. Never a headline number.** These pairs come from `Word.definition` rows",
    "> describing words the fine-tune saw glossed, in dictionary register, so they leak at",
    "> the paraphrase level (`meta.leakage: \"paraphrase\"`). They exist to detect",
    "> catastrophic regression and nothing else. They score far higher than hand-written",
    "> queries because of register, not because retrieval is good — see `eval/METHODS.md` §4.",
    ""
  );
  out.push(
    table(
      ["run", ...METRIC_HEADER],
      withTripwire.map((r) => [`\`${r.tag}\``, ...metricCells(scoreFull(tripwireOf(r)))])
    ),
    ""
  );
  return out.join("\n");
}

function headroomSection(runs: Run[]): string {
  const out: string[] = ["## 4. Reranking headroom", ""];
  out.push(
    "The decision this table drives: **reorder what is retrieved, or change what is",
    "indexed.**",
    "",
    "Each depth column is the ceiling for a **perfect** reranker over a shortlist that",
    "deep. The gap between `R@1` and a deeper column is reordering work — the answer is",
    "already retrieved and merely mis-ranked. `never retrieved` is what no reranker",
    "reaches at any depth, and it is the only slice that needs a better representation.",
    "",
    "This table is what overturned METHODS §7's *\"the margins make reranking",
    "impossible\"* — a claim measured on the lemma index, which named this very number",
    "as the thing that would falsify it (RD-12).",
    ""
  );

  const lenientAt = (scope: QueryResult[], d: number) =>
    scope.length
      ? scope.filter((r) => r.lenientRank !== null && r.lenientRank <= d).length / scope.length
      : NaN;

  const rows = runs.map((r) => {
    const scope = sliceScope(r);
    const m = scoreFull(scope);
    const deep = r.config.rankDepth > r.config.k;
    const depth = r.config.rankDepth;
    return [
      `\`${r.tag}\``,
      authoredOf(r).length ? "authored" : "tripwire",
      String(m.n),
      pct(m.lenientRecall1),
      pct(lenientAt(scope, 10)),
      deep && depth >= 50 ? pct(lenientAt(scope, 50)) : DASH,
      deep && depth >= 100 ? pct(lenientAt(scope, 100)) : DASH,
      deep ? pct(1 - lenientAt(scope, depth)) : DASH,
      deep ? String(depth) : "no deep scan",
    ];
  });

  out.push(
    table(
      ["run", "slice", "n", "R@1", "R@10", "R@50", "R@100", "never retrieved", "depth"],
      rows
    ),
    "",
    "All figures are **lenient** recall — the metric §9a resolves on.",
    ""
  );
  return out.join("\n");
}

/**
 * Two independent implementations of the same measurement, checked against
 * each other.
 *
 * At full vocabulary a lemma cell scores the same words, vectors and model as
 * the Postgres `--exact` run, through completely separate code: a brute-force
 * scan of a local Float32 buffer versus a pgvector sequential scan. They should
 * agree closely. A divergence means one of the two pipelines has a bug, and that
 * has to surface before anything is built on top of the results — which is why
 * this is generated rather than left to be remembered.
 */
function crossValidationSection(runs: Run[]): string {
  const out: string[] = ["## 5. Cross-validation — two implementations, one measurement", ""];

  const repoOf = (model: string) => model.split(" ")[0];
  const pgExact = runs.filter((r) => !r.config.index.startsWith("file:") && r.config.exact);
  const fullLemmaCells = runs.filter(
    (r) =>
      r.config.index.startsWith("file:") &&
      r.config.poolScale === "full" &&
      /lemma/.test(r.config.index)
  );

  const pairs: { pg: Run; cell: Run }[] = [];
  for (const pg of pgExact) {
    for (const cell of fullLemmaCells) {
      if (repoOf(pg.config.model) !== repoOf(cell.config.model)) continue;
      if (pg.config.setSha256 && cell.config.setSha256 && pg.config.setSha256 !== cell.config.setSha256)
        continue;
      pairs.push({ pg, cell });
    }
  }

  if (pairs.length === 0) {
    out.push(
      "*Not yet available.* This check needs a Postgres `--exact` run and a **full-scale**",
      "lemma cell on the same set and model. Until both exist, the two retrieval pipelines",
      "have never been checked against each other.",
      ""
    );
    return out.join("\n");
  }

  out.push(
    "A full-scale lemma cell and the Postgres sequential scan search the same words with",
    "the same vectors and the same model, through entirely separate implementations. Close",
    "agreement is the expected result; **a divergence means one of the two pipelines has a",
    "bug**, and nothing downstream should be trusted until it is explained.",
    "",
    "Exact equality is not expected: the cell pool is restricted to words carrying a WordNet",
    "gloss, so it is a few hundred words smaller than the production index. That accounts",
    "for a small number of disagreements, not a systematic gap.",
    ""
  );

  for (const { pg, cell } of pairs) {
    const scopeA = sliceScope(pg);
    const byId = new Map(sliceScope(cell).map((r) => [r.id, r]));
    const shared = scopeA
      .map((ra) => ({ ra, rb: byId.get(ra.id) }))
      .filter((p): p is { ra: QueryResult; rb: QueryResult } => p.rb !== undefined);
    if (shared.length === 0) continue;

    const ma = scoreFull(shared.map((p) => p.ra));
    const mb = scoreFull(shared.map((p) => p.rb));
    const sameTop1 = shared.filter(
      (p) => (p.ra.results[0] ?? "").toLowerCase() === (p.rb.results[0] ?? "").toLowerCase()
    ).length;
    const agreement = sameTop1 / shared.length;
    const deltaR1 = Math.abs(mb.recall1 - ma.recall1);

    out.push(`### \`${pg.tag}\` (pgvector) vs \`${cell.tag}\` (local scan) — ${shared.length} shared queries`, "");
    out.push(
      table(
        ["run", "implementation", ...METRIC_HEADER],
        [
          [`\`${pg.tag}\``, "pgvector sequential scan", ...metricCells(ma)],
          [`\`${cell.tag}\``, "brute-force local scan", ...metricCells(mb)],
        ]
      ),
      ""
    );

    const consistent = deltaR1 <= 0.02 && agreement >= 0.95;
    out.push(
      `**Top-1 agreement: ${pct(agreement)}** (${sameTop1}/${shared.length} queries returned the same ` +
        `first result). **|ΔR@1| = ${pct(deltaR1)}.**`,
      ""
    );
    out.push(
      consistent
        ? "> **Consistent.** The two pipelines agree within the tolerance expected from the " +
            "small pool difference. Neither implementation shows signs of a bug."
        : "> **⚠ DIVERGENT — investigate before using any Phase E result.** The two pipelines " +
            "disagree by more than the pool difference can explain. One of them is wrong. Check " +
            "vector alignment in the cell (`verify-eval-pool.ts`), the `perSense` setting, and " +
            "whether both runs used the same model.",
      ""
    );
  }

  return out.join("\n");
}

function slicesSection(runs: Run[], prereg: string): string {
  const out: string[] = ["## 6. Slices", ""];
  out.push(
    "Scope is the authored reachable slice where one exists, otherwise every reachable row.",
    "Small slices move easily: a 40-query slice shifting five points is not a finding.",
    ""
  );

  for (const r of runs) {
    const scope = sliceScope(r);
    const label = authoredOf(r).length ? "authored, reachable" : "reachable (tripwire only)";
    out.push(`### \`${r.tag}\` — ${label}, n = ${scope.length}`, "");

    const bySource = sliceTable(r.results, (q) => q.source);
    if (bySource) out.push("**by source** (all rows, including unreachable and leaked):", "", bySource, "");

    // The prediction is printed here, immediately above the slice it concerns,
    // so it cannot be read after the fact as a description of the result.
    out.push("**Pre-registered before any authored number existed:**", "", `> ${prereg}`, "");

    const byStyle = sliceTable(scope, (q) => q.meta.style as string | undefined);
    out.push("**by style:**", "", byStyle ?? "*no `style` metadata on this set.*", "");

    const byLength = sliceTable(scope, (q) => lengthBucket(q.query));
    if (byLength) out.push("**by query length:**", "", byLength, "");

    const byTokens = sliceTable(scope, (q) => q.meta.token_count as string | undefined);
    if (byTokens) out.push("**by target token count:**", "", byTokens, "");

    const byOverlap = sliceTable(scope, (q) => (q.meta.lexical_overlap as string) ?? "none");
    if (byOverlap) out.push("**by lexical overlap:**", "", byOverlap, "");

    const byBand = sliceTable(scope, (q) => bandOfZipf(q.meta.zipf));
    if (byBand) {
      out.push(
        "**by frequency band** (fixed Zipf bands; source is OpenSubtitles 2018, which",
        "under-weights literary and technical vocabulary — \"rare\" here is not rare in writing):",
        "",
        byBand,
        ""
      );
    }

    const unreachable = unreachableOf(r);
    if (unreachable.length) {
      const found = unreachable.filter((q) => q.rank !== null).length;
      const first = unreachable.filter((q) => q.lenientRank === 1).length;
      // Scored, not just counted (RD-17). "Unexpectedly retrieved" was the right
      // wording while the vocabulary was fixed and any hit was an anomaly; once a
      // change can deliberately add these words, the count has to say whether they
      // RANK, because a word that is present and never surfaces has not been added
      // in any sense a user would notice. Still excluded from every headline
      // figure — the flag is stored truth in a frozen file, so the headline
      // denominator cannot move, which is what keeps before/after comparable.
      out.push(
        `**Coverage slice:** ${unreachable.length} targets flagged absent from the vocabulary; ` +
          `**${first} at rank 1**, ${found} retrieved at all. Reported here and excluded from ` +
          `every headline figure.`,
        ""
      );
    }
  }

  return out.join("\n");
}

/** Explicit `--pair a:b`, else each set's reference run against its siblings. */
function choosePairs(runs: Run[]): { a: Run; b: Run; why: string }[] {
  const byTag = new Map(runs.map((r) => [r.tag, r]));
  const explicit = argAll("--pair");
  if (explicit.length) {
    const out: { a: Run; b: Run; why: string }[] = [];
    for (const spec of explicit) {
      const [ta, tb] = spec.split(":");
      const a = byTag.get(ta);
      const b = byTag.get(tb);
      if (a && b) out.push({ a, b, why: "requested explicitly with `--pair`" });
      else console.error(`  --pair ${spec}: unknown tag, skipped`);
    }
    return out;
  }

  // Runs are only comparable if they scored the same rows, so group by set.
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const key = r.config.setSha256 ?? r.config.set;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const out: { a: Run; b: Run; why: string }[] = [];
  const preferred = arg("--baseline");
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ref =
      group.find((r) => r.tag === preferred) ??
      group.find((r) => r.tag === "baseline") ??
      group[0]; // earliest by ranAt — "what came first", not an arbitrary pick
    for (const other of group) {
      if (other === ref) continue;
      out.push({
        a: ref,
        b: other,
        why:
          ref.tag === "baseline" || ref.tag === preferred
            ? "the designated reference run"
            : "the earliest run on this set",
      });
    }
  }
  return out;
}

function comparisonsSection(runs: Run[]): string {
  const pairs = choosePairs(runs);
  const out: string[] = ["## 7. Paired comparisons", ""];

  if (pairs.length === 0) {
    out.push("*Fewer than two runs share a set — nothing to compare.*", "");
    return out.join("\n");
  }

  out.push(
    "Comparing two independent Recall@1 figures at n ≈ 300 cannot see a three-point",
    "change. These comparisons are **paired**: every query both runs get right is",
    "discarded — that is where the variance lives — and an exact two-sided McNemar test",
    "is run on the rank-1 disagreements alone. A large-looking recall delta with a high",
    "p-value on a handful of discordant pairs is **not a win**.",
    ""
  );
  out.push(`> **${DECISION_RULE_HEADING}**`, ">", ...DECISION_RULE.map((l) => `> ${l}`), "");

  const summary: string[][] = [];
  const detail: string[] = [];

  for (const { a, b, why } of pairs) {
    const byId = new Map(b.results.map((r) => [r.id, r]));
    const paired = a.results
      .map((ra) => ({ ra, rb: byId.get(ra.id) }))
      .filter((p): p is { ra: QueryResult; rb: QueryResult } => p.rb !== undefined)
      // Headline comparisons run on the headline slice only.
      .filter(({ ra }) => ra.source === "authored" && ra.meta.reachable !== false);

    const scoped =
      paired.length > 0
        ? paired
        : a.results
            .map((ra) => ({ ra, rb: byId.get(ra.id) }))
            .filter((p): p is { ra: QueryResult; rb: QueryResult } => p.rb !== undefined);
    const onTripwire = paired.length === 0;

    if (scoped.length === 0) continue;

    const ma = scoreFull(scoped.map((p) => p.ra));
    const mb = scoreFull(scoped.map((p) => p.rb));

    // The pre-committed rule (METHODS §9a) resolves on LENIENT R@1, so the
    // paired test that decides it runs on lenient rank-1 disagreements. Strict
    // is computed alongside and reported, but it is tie-deflated for gloss
    // cells and does not decide anything.
    const lenTop1 = (r: QueryResult) => r.lenientRank === 1;
    const regressions = scoped.filter((p) => lenTop1(p.ra) && !lenTop1(p.rb));
    const wins = scoped.filter((p) => !lenTop1(p.ra) && lenTop1(p.rb));
    const { p, n } = mcnemar(regressions.length, wins.length);

    const strictRegressions = scoped.filter((p) => p.ra.rank === 1 && p.rb.rank !== 1).length;
    const strictWins = scoped.filter((p) => p.ra.rank !== 1 && p.rb.rank === 1).length;
    const strict = mcnemar(strictRegressions, strictWins);

    // A sampled cell and a full-scale cell are not measuring the same task:
    // fewer distractors is strictly easier. Flag rather than drop, since the
    // full-scale-cell-vs-Postgres cross-validation is a comparison we DO want.
    const crossScale =
      a.config.poolScale !== undefined &&
      b.config.poolScale !== undefined &&
      a.config.poolScale !== b.config.poolScale;

    // RD-17: a candidate-set change, which is NOT the same kind of problem as a
    // cross-scale one and must not be flagged with the same words. A sampled
    // pool is an easier version of the same task, so its delta means nothing. A
    // larger *vocabulary* is a different task in one direction only: the
    // reachable slice is answerable by both runs and its delta IS the regression
    // test, while the coverage slice is answerable by one of them and is the
    // capability. Both are real; the mistake would be adding them together.
    const crossVocabulary =
      a.config.vocabulary !== undefined &&
      b.config.vocabulary !== undefined &&
      a.config.vocabulary !== b.config.vocabulary;

    // A synset cell was long flagged here as "cross-surface", on the theory that
    // expanding one row into several words consumes top-k slots a per-sense cell
    // would spend on distinct results. That theory was MEASURED AND FALSIFIED:
    // synset mates already sit in one bit-identical tied block in a per-sense
    // cell, so expansion spends no slots the per-sense cell was not already
    // spending. With the tie order held constant the two are per-query identical
    // — 287/287 identical top-10 order, 0 discordant rank-1 pairs, p = 1.0.
    //
    // What genuinely differs is the TIE-BREAK POLICY: a per-sense cell resolves
    // equal scores alphabetically (`compareWord`), a synset cell by its
    // `--expansion-order`. Both are answer-key-independent, but they are not the
    // same policy, and on tied queries that is the only thing separating them.
    // So the comparison is valid; it just measures policy as well as
    // representation, and the report says which.
    const isSynset = (r: Run) => r.config.cellVariant === "gloss_synset";
    const tieOrderOf = (r: Run) =>
      isSynset(r) ? String(r.config.expansionOrder ?? "unknown") : "alphabetical";
    const crossTieBreak = tieOrderOf(a) !== tieOrderOf(b);

    summary.push([
      `\`${a.tag}\` → \`${b.tag}\``,
      crossScale
        ? "⚠ **cross-scale**"
        : crossTieBreak
          ? "⚠ **tie-break differs**"
          : onTripwire
          ? "tripwire *(leaked)*"
          : "authored",
      String(scoped.length),
      `${pct(ma.lenientRecall1)} → ${pct(mb.lenientRecall1)}`,
      `${((mb.lenientRecall1 - ma.lenientRecall1) * 100).toFixed(1)} pts`,
      `${wins.length} / ${regressions.length}`,
      String(n),
      p.toFixed(4),
      verdict(mb.lenientRecall1 - ma.lenientRecall1, p),
      `${pct(ma.recall1)} → ${pct(mb.recall1)}`,
      `${pct(ma.echoRate)} → ${pct(mb.echoRate)}`,
    ]);

    detail.push(`### \`${a.tag}\` → \`${b.tag}\``, "");
    detail.push(
      `Reference is \`${a.tag}\` — ${why}. Scored on ${scoped.length} shared queries.`,
      ""
    );
    if (onTripwire) {
      detail.push(
        "> Scored on the leaked tripwire slice because these runs share no authored rows.",
        "> A regression detector, not a result.",
        ""
      );
    }
    if (crossTieBreak) {
      detail.push(
        `> **These runs resolve ties differently** — \`${a.tag}\` by ${tieOrderOf(a)}, ` +
          `\`${b.tag}\` by ${tieOrderOf(b)}.`,
        "> Synset mates share one gloss, so their vectors are bit-identical and the tie order",
        "> alone decides rank 1 on those queries. Both policies here are independent of the",
        "> answer key, so the comparison IS valid — but the delta below mixes a representation",
        "> effect with a tie-break-policy effect, and on tied queries the policy is the whole",
        "> of it. An earlier version of this report called such a pair \"cross-surface\" and",
        "> refused to interpret it; that was measured and falsified (METHODS.md §10, §12).",
        ""
      );
    }
    if (crossVocabulary) {
      detail.push(
        `> **Different candidate sets.** \`${a.tag}\` searched a ${a.config.vocabulary} index and`,
        `> \`${b.tag}\` a ${b.config.vocabulary} one` +
          (b.config.supplementArm ? ` (arm \`${b.config.supplementArm}\`, filter \`${b.config.filterVersion ?? "?"}\`)` : "") +
          ".",
        "> The delta on the authored-reachable slice below IS interpretable and is the regression",
        "> test: both runs can answer those queries, and `meta.reachable` is stored truth in a",
        "> frozen set, so the denominator cannot move. What is NOT interpretable is comparing",
        "> overall recall across the two as a single quality number — the coverage slice is a",
        "> capability the smaller index does not have, and it is reported on its own.",
        ""
      );
    }
    if (crossScale) {
      detail.push(
        `> **Cross-scale comparison — the delta below is not interpretable.** \`${a.tag}\` searched a`,
        `> ${a.config.poolScale} pool (${(a.config.poolWords ?? 0).toLocaleString()} words) and \`${b.tag}\` a`,
        `> ${b.config.poolScale} pool (${(b.config.poolWords ?? 0).toLocaleString()} words). Fewer distractors is a`,
        "> strictly easier task, so any difference here confounds representation with pool size.",
        "> Shown for completeness only; do not read it as a result.",
        ""
      );
    }
    detail.push(
      table(
        ["run", ...METRIC_HEADER],
        [
          [`\`${a.tag}\``, ...metricCells(ma)],
          [`\`${b.tag}\``, ...metricCells(mb)],
        ]
      ),
      ""
    );
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    detail.push(
      `**Lenient R@1** (the metric §9a resolves on) — McNemar exact, two-sided: ` +
        `**${plural(wins.length, "win")}**, **${plural(regressions.length, "regression")}**, ` +
        `${n} discordant pairs, **p = ${p.toFixed(5)}** — ` +
        `${p < 0.05 ? "significant at 0.05" : "not significant at 0.05"}. ` +
        `The ${scoped.length - n} queries both runs agree on carry no information here.`,
      "",
      `Strict R@1, for reference only — ${strictWins} wins, ${strictRegressions} regressions, ` +
        `${strict.n} discordant, p = ${strict.p.toFixed(5)}. Tie-deflated for gloss cells; ` +
        `it does not decide anything.`,
      ""
    );

    const names = (label: string, rows: { ra: QueryResult; rb: QueryResult }[]) => {
      if (!rows.length) return;
      detail.push(`**${label} (${rows.length}):**`, "");
      for (const { ra, rb } of rows.slice(0, 20)) {
        detail.push(
          `- \`${ra.target}\` — "${ra.query}"  ` +
            `<br>${a.tag}: ${ra.results[0] ?? DASH} (rank ${ra.rank ?? ">depth"}) · ` +
            `${b.tag}: ${rb.results[0] ?? DASH} (rank ${rb.rank ?? ">depth"})`
        );
      }
      if (rows.length > 20) detail.push(`- …and ${rows.length - 20} more`);
      detail.push("");
    };
    names(`Wins for \`${b.tag}\``, wins);
    names(`Regressions under \`${b.tag}\``, regressions);

    detail.push(
      `Echo rate ${pct(ma.echoRate)} → ${pct(mb.echoRate)} ` +
        `(${((mb.echoRate - ma.echoRate) * 100).toFixed(1)} points). Echo is the mechanism, so a real ` +
        "representation fix should move both echo and recall; one without the other needs explaining.",
      ""
    );
  }

  out.push(
    table(
      [
        "comparison",
        "slice",
        "n",
        "lenient R@1",
        "Δ",
        "wins / regressions",
        "discordant",
        "p",
        "verdict (§9a)",
        "strict R@1",
        "echo",
      ],
      summary
    ),
    ""
  );
  out.push(...detail);
  return out.join("\n");
}

function provenanceSection(runs: Run[]): string {
  const out: string[] = ["## 8. Provenance", ""];

  const rows = runs.map((r) => {
    const totals = r.results.map((q) => q.embedMs + q.dbMs);
    const local = r.config.index.startsWith("file:");
    return [
      `\`${r.tag}\``,
      r.config.ranAt.replace("T", " ").replace(/\..*$/, "Z"),
      `\`${r.config.model}\``,
      `\`${r.config.index}\``,
      r.config.exact ? "exact scan" : r.config.exactByConstruction ? "exact (brute force)" : `probes=${r.config.probes}`,
      r.config.filterJunk ? "junk filtered" : "unfiltered",
      String(r.config.rows),
      local ? `${DASH} *(local)*` : `${percentile(totals, 50).toFixed(0)} / ${percentile(totals, 95).toFixed(0)}`,
      `\`${r.file}\``,
    ];
  });

  out.push(
    table(
      ["run", "ran at (UTC)", "model", "index / cell", "search", "pool", "rows", "latency p50/p95 ms", "file"],
      rows
    ),
    ""
  );

  out.push(
    "**Latency is not production latency.** These figures are a local-machine-to-Neon",
    "round trip; in production the function and the database both sit in `iad1`. They are",
    "valid for comparing runs on one machine and invalid for describing user experience.",
    "Runs against a local file-backed cell report no latency at all — a brute-force scan of",
    "a local pool has no bearing on how anything performs.",
    ""
  );

  const pooled = runs.filter((r) => r.config.poolScope);
  if (pooled.length) {
    out.push(
      "**Cell runs.** These searched a local file-backed pool rather than the production",
      "index. Their absolute recall is **not comparable to production** — only the relative",
      "ordering across cells of the *same scale* is valid. A `sampled` cell and a `full`",
      "cell are not comparable to each other either. See `eval/METHODS.md` §10.",
      ""
    );
    out.push(
      table(
        ["run", "scale", "pool words", "scope"],
        pooled.map((r) => [
          `\`${r.tag}\``,
          r.config.poolScale ?? "*unrecorded*",
          r.config.poolWords ? r.config.poolWords.toLocaleString() : DASH,
          r.config.poolScope!.replace(/\s+/g, " "),
        ])
      ),
      ""
    );

    const scales = new Set(pooled.map((r) => r.config.poolScale ?? "unrecorded"));
    if (scales.size > 1) {
      out.push(
        "> **Two pool scales are present in this report.** Cells built from different pools",
        "> answer different questions. Every comparison that crosses the boundary is marked",
        "> ⚠ cross-scale in §7 and must not be read as a result.",
        ""
      );
    }
  }

  const preregs = [...new Set(runs.map((r) => r.preregistered).filter(Boolean))] as string[];
  if (preregs.length > 1) {
    out.push(
      "> **The pre-registered note is not identical across runs.** It is meant to be a",
      "> constant; differing text means it was edited after some runs were scored.",
      ""
    );
  }

  return out.join("\n");
}

// ------------------------------------------------------------------ main

function main(): void {
  const runsDir = arg("--runs") ?? DEFAULT_RUNS;
  const outPath = arg("--out") ?? DEFAULT_OUT;

  const all = loadRuns(runsDir);
  const only = arg("--only");
  const runs = only ? all.filter((r) => only.split(",").includes(r.tag)) : all;

  if (runs.length === 0) {
    console.error(`No runs found in ${runsDir}. Run scripts/eval.ts first.`);
    process.exitCode = 1;
    return;
  }

  const prereg =
    runs.map((r) => r.preregistered).find(Boolean) ??
    "(no pre-registered note recorded in these runs)";

  const doc: string[] = [];
  doc.push("# Retrieval evaluation — results", "");
  doc.push(
    `*Generated by \`scripts/report.ts\` on ${new Date().toISOString().replace("T", " ").replace(/\..*$/, "Z")} ` +
      `from ${runs.length} run${runs.length === 1 ? "" : "s"} in \`${runsDir}\`.*`,
    "",
    "**Do not edit this file by hand.** It is regenerated after every run; a hand edit is",
    "lost on the next regeneration, and a figure that is wrong here is wrong in",
    "`scripts/report.ts` or in the run JSON, never in the markdown. Regenerate with:",
    "",
    "```bash",
    "npx tsx scripts/report.ts",
    "```",
    "",
    "The reasoning behind every choice below — why the set is hand-authored, why WordNet",
    "glosses are barred from the test set but allowed in the index, what the blind drafting",
    "protocol is, and which hypotheses are already dead — is in **`eval/METHODS.md`**, which",
    "is hand-written and does not change when the numbers do.",
    ""
  );

  const anyAuthored = runs.some((r) => authoredOf(r).length > 0);
  if (!anyAuthored) {
    doc.push(
      "> ## ⚠ No baseline exists yet",
      ">",
      "> Every run below was scored against the quarantined `gloss_tripwire` slice, which is",
      "> leaked and written in dictionary register. **None of these numbers is a baseline and",
      "> none describes performance on hand-written queries.** The authored set is not yet",
      "> built. See §3.",
      ""
    );
  }

  doc.push(setIdentitySection(runs), "");
  doc.push(headlineSection(runs), "");
  const tw = tripwireSection(runs);
  if (tw) doc.push(tw, "");
  doc.push(headroomSection(runs), "");
  doc.push(crossValidationSection(runs), "");
  doc.push(slicesSection(runs, prereg), "");
  doc.push(comparisonsSection(runs), "");
  doc.push(provenanceSection(runs), "");

  const body = doc.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  const full = path.resolve(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf8");

  console.log(`Wrote ${path.relative(process.cwd(), full)}`);
  console.log(`  runs        ${runs.map((r) => r.tag).join(", ")}`);
  console.log(`  authored    ${anyAuthored ? "yes" : "NO — tripwire only, not a baseline"}`);
  console.log(`  ${body.split("\n").length} lines, ${(body.length / 1024).toFixed(1)} KB`);
}

main();
