/**
 * Guard: check that no run's score is being propped up by how it breaks ties.
 *
 * This began as a correction applied to numbers after the fact. Every right
 * answer used to sit in the first few hundred rows of the pool, and ties were
 * broken by row order — so the right answer won every tie it was in, inflating
 * scores substantially. Both causes are now fixed in the pipeline, so this no
 * longer corrects anything. It checks, and it fails.
 *
 * The check: under a tie rule that cannot see the answer key, the odds of a
 * correct word landing first are simply its share of the tied group. Adding
 * those up gives exactly what a neutral tie rule should score. A run sitting far
 * above that is winning ties for reasons connected to the answer key, which is
 * the bug coming back.
 *
 * The threshold is one-sided and generous on purpose. A fixed rule is one roll
 * of the dice, not the average, so a few points either way is noise. Sitting
 * below expectation is harmless; only a large excess is evidence of trouble.
 *
 *   npx tsx scripts/verify-tiebreak.ts
 *   npx tsx scripts/verify-tiebreak.ts --runs cell_gloss_ft,cell_lemma_ft
 */
import fs from "node:fs";
import path from "node:path";

const RUNS = path.resolve(process.cwd(), "eval/runs");
const norm = (s: string) => s.trim().toLowerCase();

/** How far above the neutral expectation a run may sit before this complains. */
const TOLERANCE = 0.05;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

type Row = {
  tag: string;
  n: number;
  strict: number;
  strictNeutral: number;
  lenient: number;
  lenientNeutral: number;
  tiedQueries: number;
  saturated: number;
};

function audit(tag: string): Row | null {
  const file = path.join(RUNS, `${tag}.json`);
  if (!fs.existsSync(file)) return null;
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  const auth = run.results.filter(
    (r: any) => r.source === "authored" && r.meta.reachable !== false
  );
  if (!auth.length) return null;

  let strict = 0, strictNeutral = 0, lenient = 0, lenientNeutral = 0;
  let tiedQueries = 0, saturated = 0;

  for (const r of auth) {
    const acc = new Set([r.target, ...(r.meta.acceptable ?? [])].map(norm));
    const s0 = r.similarities[0];
    let g = 0;
    for (const s of r.similarities) {
      if (s === s0) g++;
      else break;
    }
    if (g > 1) tiedQueries++;
    if (g === r.similarities.length) saturated++;

    const head = r.results.slice(0, g).map(norm);
    if (r.rank === 1) strict++;
    if (r.lenientRank === 1) lenient++;
    strictNeutral += head.includes(norm(r.target)) ? 1 / g : 0;
    lenientNeutral += head.filter((w: string) => acc.has(w)).length / g;
  }

  return { tag, n: auth.length, strict, strictNeutral, lenient, lenientNeutral, tiedQueries, saturated };
}

function main(): void {
  const tags = (
    arg("--runs")?.split(",") ??
    fs.readdirSync(RUNS).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
  ).map((t) => t.trim());

  const rows = tags.map(audit).filter((r): r is Row => r !== null);
  if (!rows.length) {
    console.error("no runs with an authored slice found");
    process.exitCode = 1;
    return;
  }

  const pct = (x: number, n: number) => `${((x / n) * 100).toFixed(1)}%`;
  const failures: Row[] = [];
  const warnings: Row[] = [];

  console.log("Tie-break neutrality check\n");
  console.log(
    `  ${"run".padEnd(26)} ${"n".padStart(4)}  ${"R@1".padStart(6)} ${"neutral".padStart(7)}  ` +
      `${"lenR@1".padStart(6)} ${"neutral".padStart(7)}  ${"excess".padStart(6)}  ${"tied".padStart(5)}`
  );
  for (const r of rows.sort((a, b) => b.lenient / b.n - a.lenient / a.n)) {
    const excess = (r.lenient - r.lenientNeutral) / r.n;
    const strictExcess = (r.strict - r.strictNeutral) / r.n;
    const worst = Math.max(excess, strictExcess);
    if (worst > TOLERANCE) failures.push(r);
    if (r.saturated) warnings.push(r);
    console.log(
      `  ${r.tag.padEnd(26)} ${String(r.n).padStart(4)}  ` +
        `${pct(r.strict, r.n).padStart(6)} ${pct(r.strictNeutral, r.n).padStart(7)}  ` +
        `${pct(r.lenient, r.n).padStart(6)} ${pct(r.lenientNeutral, r.n).padStart(7)}  ` +
        `${(worst * 100 >= 0 ? "+" : "") + (worst * 100).toFixed(1)}`.padStart(8) +
        `  ${String(r.tiedQueries).padStart(5)}` +
        (worst > TOLERANCE ? "   <== FAIL" : "")
    );
  }

  console.log(
    `\n  "excess" is how far the run's actual Recall@1 sits ABOVE what a tie order\n` +
      `  that cannot see the answer key would produce, taking the worse of strict and\n` +
      `  lenient. Near zero (either sign) is the expected state. Above ` +
      `+${(TOLERANCE * 100).toFixed(1)} points is\n  the METHODS.md §12 contamination returning.`
  );

  for (const r of warnings) {
    console.log(
      `\n  WARNING ${r.tag}: ${r.saturated} tie groups fill the entire top-k, so their\n` +
        `  true size is unknown and the neutral figure there is an UPPER bound.\n` +
        `  Re-run with a larger --k to measure those exactly.`
    );
  }

  if (failures.length) {
    console.log(
      `\n  FAILED: ${failures.map((f) => f.tag).join(", ")}\n\n` +
        `  Check, in order:\n` +
        `    1. build-eval-pool.ts still shuffles targets into the pool (it prints the\n` +
        `       mean target row; it should be about half the pool size).\n` +
        `    2. localIndex.ts still breaks every tie with compareWord, not row order.\n` +
        `    3. the cells were rebuilt from the CURRENT pool — a stale cell carries the\n` +
        `       old layout. verify-eval-pool.ts checks that against the input hash.`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\n  PASS — no run exceeds its neutral expectation by more than the tolerance.`);
}

main();
