/**
 * Does phrasing still matter as much as it used to?
 *
 * An early measurement found a huge gap: questions phrased like dictionary
 * definitions scored far better than questions written the way people talk. That
 * finding is load-bearing — it justifies writing the test questions blind, and
 * the size of it is where this project's "worth acting on" bar comes from.
 *
 * It is also a fact about the old index, measured days before that index was
 * replaced. This re-derives it on both, because a diagnostic does not
 * automatically survive the change it motivated.
 *
 * It compares two groups of the same frozen set, scored in one run: the blind
 * hand-written questions, and the 93 that were paraphrased from dictionary
 * definitions. That second group is kept out of every headline number and stays
 * that way — here it is used as an instrument for measuring phrasing
 * sensitivity, which is the one thing a leaked group is honestly good for.
 *
 * The two groups have no answers in common, so this is not a like-for-like
 * comparison and no significance test is reported. That is why the conditional
 * figure exists: the leaked group's answers are the easier ones, and that line
 * divides the advantage back out.
 *
 * Reads saved runs and nothing else — no database, no model.
 *
 *   npx tsx scripts/probe-register-gap.ts
 *   npx tsx scripts/probe-register-gap.ts eval/runs/a.json eval/runs/b.json
 */
import fs from "node:fs";
import path from "node:path";
import type { QueryResult } from "./lib/metrics";

/** The old index, then what serves users today. */
const DEFAULT_RUNS = ["eval/runs/baseline.json", "eval/runs/prod_gloss_shipped.json"];

type Run = { tag: string; config?: Record<string, unknown>; results: QueryResult[] };

type Slice = {
  n: number;
  r1: number;
  r10: number;
    /** How deep the run looked for the answer. */
  in100: number;
    /** How often it came first, among questions whose answer was found at all. */
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

/** The forgiving measure throughout, which is what decisions are made on. */
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
        // The headline questions: hand-written, minus the ones no dictionary could
        // answer — exactly how every score in this project is defined.
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
