/**
 * RD-17 step 3 — apply the Wiktionary filter and emit the candidate rows.
 *
 * Streams the 3.2 GB Kaikki extraction once per arm, never holding it whole,
 * and writes one JSONL row per surviving sense in the exact shape a
 * `GlossEmbedding` row has. Nothing here embeds anything and nothing here
 * writes to the database — the output is a candidate list, and RD-17 step 4
 * says the numbers come from a local cell before any table is touched.
 *
 * TWO ARMS, because the filter's aggressiveness is the parameter this ticket
 * lives or dies on and guessing it would be the same mistake RD-12 and RD-16
 * were built to avoid:
 *
 *   wikt_new   index a sense only when its headword is not ALREADY answerable
 *              from the live index. Adds capability, adds the fewest possible
 *              distractors to the 117,791 senses that already work.
 *   wikt_all   index every sense that survives the filter, including new senses
 *              of words WordNet already covers. Maximum coverage, maximum
 *              distractor risk.
 *
 * The difference between the two arms' scores IS the distractor cost of the
 * extra senses. That is the number, and it is why both are built.
 *
 * THE PAYLOAD CHECK. The run reports how many of the eval set's 23 unreachable
 * targets survive the filter. This is NOT the filter being tuned per word — the
 * rules are chosen a priori from tag semantics, and no rule references a target.
 * It is reported because a filter that kills the payload is a filter that is
 * wrong in general, which is exactly how the frequency gate was rejected.
 *
 *   npx tsx scripts/build-supplement.ts                  # both arms
 *   npx tsx scripts/build-supplement.ts --arm wikt_new
 *   npx tsx scripts/build-supplement.ts --limit 200000   # dry pass over a prefix
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { fileSha256, readLines, sourcePath } from "./lib/sources";
import {
  FILTER_VERSION,
  LICENCE,
  SOURCE_URL,
  emptyCounts,
  emptyState,
  filterEntry,
  type FilterCounts,
  type KaikkiEntry,
  type SupplementRow,
} from "./lib/wiktionary";

loadEnv();

const SOURCE_FILE = "kaikki-english.jsonl";
const MANIFEST = path.resolve(process.cwd(), "eval/data/supplement-manifest.json");
const EVAL_SET = "eval/sets/v1.jsonl";

type Arm = "wikt_new" | "wikt_all";
const ARMS: Arm[] = ["wikt_new", "wikt_all"];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** The eval set's coverage slice — the words this ticket exists to add. */
function unreachableTargets(): string[] {
  return fs
    .readFileSync(EVAL_SET, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { target: string; meta: { reachable?: boolean } })
    .filter((r) => r.meta.reachable === false)
    .map((r) => r.target.toLowerCase());
}

/** Lemmas the live index can already return. The honest "already covered" set. */
async function answerableLemmas(prisma: PrismaClient): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ w: string }[]>(
    `SELECT DISTINCT lower(unnest(lemmas)) AS w FROM "GlossEmbedding"`
  );
  return new Set(rows.map((r) => r.w));
}

type ArmResult = {
  arm: Arm;
  rows: number;
  words: number;
  counts: FilterCounts;
  targetsCovered: string[];
  keys: number;
  file: string;
};

async function buildArm(
  arm: Arm,
  source: string,
  answerable: Set<string>,
  targets: string[],
  limit: number
): Promise<ArmResult> {
  const outFile = sourcePath(`supplement-${arm}.jsonl`);
  const out = fs.createWriteStream(outFile, { encoding: "utf8" });
  const counts = emptyCounts();
  const state = emptyState();
  const words = new Set<string>();
  const targetSet = new Set(targets);
  const covered = new Set<string>();
  // Structurally guaranteed by `senseIndex`, and checked anyway: a colliding key
  // is silent data loss on the way into Postgres, where `ON CONFLICT
  // ("synsetKey") DO UPDATE` turns the second row into an overwrite of the
  // first. The first version of this filter numbered senses within an entry
  // rather than across them and produced 5,925 collisions from homographs with
  // separate etymologies (`cat` the animal, `cat` the Unix command). The cell
  // would have been measured with rows the table could never hold.
  const keys = new Set<string>();
  let collisions = 0;

  // Buffered rather than one write() per row: 300k+ syscalls otherwise, and the
  // stream backpressure dance costs more than the memory this holds.
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length) out.write(buffer.join(""));
    buffer = [];
  };

  const isAnswerable =
    arm === "wikt_new" ? (w: string) => answerable.has(w) : undefined;

  let lines = 0;
  const started = Date.now();
  for await (const line of readLines(source)) {
    if (++lines > limit) break;
    let entry: KaikkiEntry;
    try {
      entry = JSON.parse(line) as KaikkiEntry;
    } catch {
      continue;
    }
    const kept = filterEntry(entry, counts, state, isAnswerable);
    for (const row of kept) {
      if (keys.has(row.key)) collisions++;
      else keys.add(row.key);
      buffer.push(JSON.stringify(row) + "\n");
      words.add(row.lemmas[0].toLowerCase());
      if (targetSet.has(row.lemmas[0].toLowerCase())) covered.add(row.lemmas[0].toLowerCase());
    }
    if (buffer.length >= 2000) flush();
    if (lines % 500_000 === 0) {
      const secs = (Date.now() - started) / 1000;
      process.stdout.write(
        `\r  ${arm}: ${lines.toLocaleString()} entries read, ` +
          `${counts.kept.toLocaleString()} senses kept  (${(lines / secs).toFixed(0)}/s)   `
      );
    }
  }
  flush();
  await new Promise<void>((resolve) => out.end(resolve));

  console.log(
    `\r  ${arm}: ${lines.toLocaleString()} entries read, ` +
      `${counts.kept.toLocaleString()} senses kept over ${words.size.toLocaleString()} words   `
  );
  if (collisions > 0) {
    throw new Error(
      `${arm}: ${collisions} colliding keys. Every row must have a unique key or the ` +
        `INSERT will silently drop rows the cell was measured with.`
    );
  }

  return {
    arm,
    rows: counts.kept,
    words: words.size,
    counts,
    targetsCovered: [...covered].sort(),
    keys: keys.size,
    file: outFile,
  };
}

function reportCounts(counts: FilterCounts): void {
  const order: (keyof FilterCounts)[] = [
    "kept",
    "lang",
    "pos",
    "surface",
    "already_answerable",
    "form_ref",
    "form_tag",
    "dead_tag",
    "no_gloss",
    "shell_gloss",
    "short_gloss",
    "sense_cap",
    "duplicate",
  ];
  for (const key of order) {
    console.log(`      ${String(key).padEnd(20)} ${counts[key].toLocaleString().padStart(12)}`);
  }
}

async function main(): Promise<void> {
  const source = arg("--source") ?? sourcePath(SOURCE_FILE);
  const only = arg("--arm") as Arm | undefined;
  const limit = Number(arg("--limit") ?? Infinity);

  if (!fs.existsSync(source)) {
    console.error(`\nno ${source}\n\n  npx tsx scripts/fetch-wiktionary.ts\n`);
    process.exitCode = 1;
    return;
  }

  console.log("\nRD-17 · Wiktionary supplement\n");
  console.log(`  source        ${source}`);
  console.log(`  size          ${(fs.statSync(source).size / 1e9).toFixed(2)} GB`);
  console.log(`  filter        ${FILTER_VERSION}`);

  const targets = unreachableTargets();
  const prisma = new PrismaClient();
  let answerable: Set<string>;
  try {
    answerable = await answerableLemmas(prisma);
  } finally {
    await prisma.$disconnect();
  }
  console.log(`  answerable    ${answerable.size.toLocaleString()} lemmas on the live index`);
  console.log(`  coverage slice ${targets.length} unreachable eval targets\n`);

  const arms = only ? [only] : ARMS;
  const results: ArmResult[] = [];
  for (const arm of arms) {
    results.push(await buildArm(arm, source, answerable, targets, limit));
  }

  console.log("");
  for (const r of results) {
    console.log(`  ${r.arm}`);
    reportCounts(r.counts);
    console.log(
      `      -> ${r.rows.toLocaleString()} rows, ${r.words.toLocaleString()} distinct words, ` +
        `${(fs.statSync(r.file).size / 1e6).toFixed(0)} MB`
    );
    // 1.85 KB per row is the measured GlossEmbedding figure: 213 MB over
    // 117,791 rows, heap plus indexes.
    console.log(
      `      -> projected in Postgres at 1.85 KB/row: ${((r.rows * 1.85) / 1e3).toFixed(0)} MB`
    );
    console.log(
      `      -> coverage payload: ${r.targetsCovered.length}/${targets.length} unreachable targets present`
    );
    const missed = targets.filter((t) => !r.targetsCovered.includes(t));
    if (missed.length) console.log(`         missing: ${missed.join(", ")}`);
    console.log("");
  }

  // Merge rather than replace. `--arm wikt_new` is the natural way to rebuild one
  // side, and a whole-file rewrite would silently drop the other arm's record
  // while the file still looked complete — the manifest is the committed
  // artifact, so a half-written one is worse than a missing one.
  const previous = fs.existsSync(MANIFEST)
    ? (JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as { arms?: { arm: string }[] })
    : { arms: [] };
  const rebuilt = new Set(results.map((r) => r.arm));
  const carried = (previous.arms ?? []).filter((a) => !rebuilt.has(a.arm as Arm));

  const manifest = {
    ticket: "RD-17",
    builtAt: new Date().toISOString(),
    filterVersion: FILTER_VERSION,
    source: {
      url: SOURCE_URL,
      file: path.basename(source),
      bytes: fs.statSync(source).size,
      sha256: await fileSha256(source),
      licence: LICENCE,
    },
    evalCoverageSlice: targets,
    arms: [
      ...carried,
      ...results.map((r) => ({
        arm: r.arm,
        rows: r.rows,
        distinctWords: r.words,
        counts: r.counts,
        distinctKeys: r.keys,
        targetsCovered: r.targetsCovered,
      })),
    ].sort((a, b) => (a.arm < b.arm ? -1 : 1)),
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`  manifest -> ${path.relative(process.cwd(), MANIFEST)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
