/**
 * Has the register gap survived the gloss cutover? (RD-16)
 *
 * METHODS §4 records a **~43-point register gap**: the `gloss_tripwire` slice —
 * paraphrases of dictionary definitions — scored R@10 62.4% while hand-written
 * queries scored roughly 19%. That number is load-bearing well beyond §4. It is
 * the stated justification for the blind drafting protocol (§5), and §9a cites
 * it as the *effect size that would justify a representation change*, which is
 * where the project's ~6-point decision bar comes from.
 *
 * It is also a fact about the LEMMA index, measured 2026-08-19, eight days
 * before RD-02 replaced that index. This probe re-derives it on both, because a
 * diagnostic does not automatically survive the change it motivated — the same
 * trap RD-12 recorded when "a reranker has nothing to reorder" quietly became
 * false the moment the cutover shipped.
 *
 * WHAT IT COMPARES. Two slices of the same frozen set, scored in the same run:
 *
 *   authored        blind descriptions, no gloss ever consulted (§5)
 *   gloss_tripwire  93 paraphrases of `Word.definition`, `meta.leakage:
 *                   "paraphrase"` — maximum register match PLUS leakage
 *
 * The tripwire is quarantined from every headline number and stays quarantined:
 * this reads it as an *instrument* for measuring phrasing sensitivity, which is
 * the one thing a leaked slice is honestly good for.
 *
 * WHAT IT IS NOT. The two slices have disjoint targets (0 of 93 shared), so this
 * is not a matched-pairs comparison and no paired test is reported. That is why
 * the conditional line below exists: tripwire targets are the easier ones, and
 * `R@1 | in top 100` divides that advantage back out.
 *
 * Reads committed run artifacts and nothing else — no database, no model.
 *
 *   npx tsx scripts/probe-register-gap.ts
 *   npx tsx scripts/probe-register-gap.ts eval/runs/a.json eval/runs/b.json
 */
import fs from "node:fs";
import path from "node:path";
import type { QueryResult } from "./lib/metrics";

/** The pre-cutover lemma index, then what serves users today. */
const DEFAULT_RUNS = ["eval/runs/baseline.json", "eval/runs/prod_gloss_shipped.json"];

type Run = { tag: string; config?: Record<string, unknown>; results: QueryResult[] };

type Slice = {
  n: number;
  r1: number;
  r10: number;
  /** Deep-scan reach: the harness retrieves to `--rank-depth` (100 by default). */
  in100: number;
  /** R@1 among the queries whose target was retrievable at all. */
  r1GivenIn100: number;
};

function load(file: string): Run {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) {
    throw new Error(
      `${file} not found. The committed reference runs are baseline.json, exact.json, ` +
        `filtered.json and prod_gloss_shipped.json; regenerate others with npm run eval:*.`
    );
  }
  return JSON.parse(fs.readFileSync(full, "utf8")) as Run;
}

/** Lenient rank throughout: METHODS §9a resolves on it, and §4's figure predates that amendment. */
function measure(rows: QueryResult[]): Slice {
  const n = rows.length;
  const within = (d: number) => rows.filter((r) => r.lenientRank !== null && r.lenientRank <= d).length;
  const reached = rows.filter((r) => r.lenientRank !== null && r.lenientRank <= 100);
  return {
    n,
    r1: within(1) / n,
    r10: within(10) / n,
    in100: reached.length / n,
    r1GivenIn100: reached.length === 0 ? NaN : within(1) / reached.length,
  };
}

function slicesOf(run: Run): { authored: Slice; tripwire: Slice } {
  return {
    // The headline slice: authored MINUS the coverage rows, exactly as every
    // recall figure in this project is defined.
    authored: measure(
      run.results.filter((r) => r.source === "authored" && r.meta.reachable !== false)
    ),
    tripwire: measure(run.results.filter((r) => r.source === "gloss_tripwire")),
  };
}

const pct = (x: number) => (Number.isNaN(x) ? "  —  " : (100 * x).toFixed(1).padStart(5) + "%");
const pp = (x: number) => (x >= 0 ? "+" : "") + (100 * x).toFixed(1) + "pp";

function main(): void {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const runs = (files.length ? files : DEFAULT_RUNS).map(load);

  console.log("\nRegister gap — gloss_tripwire (definition register, leaked) vs authored (blind)\n");
  console.log(
    "  " +
      "run".padEnd(24) +
      "slice".padEnd(10) +
      "n".padStart(5) +
      "  " +
      "R@1".padStart(6) +
      "  " +
      "R@10".padStart(6) +
      "  " +
      "in100".padStart(6) +
      "  " +
      "R@1|in100".padStart(9)
  );
  console.log("  " + "-".repeat(78));

  for (const run of runs) {
    const { authored, tripwire } = slicesOf(run);
    for (const [label, s] of [
      ["authored", authored],
      ["tripwire", tripwire],
    ] as const) {
      console.log(
        "  " +
          (label === "authored" ? run.tag : "").padEnd(24) +
          label.padEnd(10) +
          String(s.n).padStart(5) +
          "  " +
          pct(s.r1) +
          "  " +
          pct(s.r10) +
          "  " +
          pct(s.in100) +
          "  " +
          pct(s.r1GivenIn100).padStart(9)
      );
    }
    console.log(
      "  " +
        "".padEnd(24) +
        "GAP".padEnd(10) +
        "".padStart(5) +
        "  " +
        pp(tripwire.r1 - authored.r1).padStart(6) +
        "  " +
        pp(tripwire.r10 - authored.r10).padStart(6) +
        "  " +
        pp(tripwire.in100 - authored.in100).padStart(6) +
        "  " +
        pp(tripwire.r1GivenIn100 - authored.r1GivenIn100).padStart(9)
    );
    console.log("");
  }

  console.log("  Reading it:");
  console.log(
    "    A POSITIVE gap means phrasing a query in dictionary register helps — the effect"
  );
  console.log(
    "    METHODS §4 named at ~43 points and §9a leans on as its effect-size anchor. A gap"
  );
  console.log(
    "    at or below zero means the index no longer cares how the question is phrased,"
  );
  console.log(
    "    and RD-14's premise ('nobody types gloss text') no longer describes this system."
  );
  console.log(
    "\n    `R@1|in100` divides out the slices' unequal difficulty: the tripwire's targets are"
  );
  console.log(
    "    the easier ones, so a flat headline R@1 with a higher `in100` means the register-"
  );
  console.log("    matched slice is doing WORSE per retrievable query, not merely the same.\n");
}

main();
