/**
 * Apply the Wiktionary filter and write out the candidate rows.
 *
 * Streams the multi-gigabyte source once per variant, never holding it whole,
 * and writes one row per surviving entry in the shape the index uses. Nothing
 * here measures anything and nothing here writes to the database — this is a
 * candidate list, and the numbers come from a local file first.
 *
 * Two variants, because how aggressive the filter should be is the question this
 * work lives or dies on, and guessing it would be the mistake earlier
 * experiments were built to avoid:
 *
 *   wikt_new   add an entry only for words the index cannot already answer.
 *              Adds new ability, adds the fewest possible wrong answers.
 *   wikt_all   add every entry that survives the filter, including new meanings
 *              of words already covered. Most coverage, most risk.
 *
 * The gap between the two scores IS the cost of those extra wrong answers. That
 * is the number, and it is why both are built.
 *
 * The run also reports how many of the words this work exists to add survive the
 * filter. The rules are chosen in advance and none of them mentions a specific
 * word — it is reported because a filter that kills the payload is a filter that
 * is wrong in general.
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

/** The words this work exists to add. */
function unreachableTargets(): string[] {
  return fs
    .readFileSync(EVAL_SET, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { target: string; meta: { reachable?: boolean } })
    .filter((r) => r.meta.reachable === false)
    .map((r) => r.target.toLowerCase());
}

/** Words the live index can already return — the honest "already covered" list. */
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
    // Guaranteed by construction, and checked anyway: a clashing key is silent
    // data loss on the way into the database, where the second row would overwrite
    // the first. An earlier version of this filter produced thousands of clashes
    // from words with more than one origin, and the experiment would have been
    // measured with rows the table could never actually hold.
  const keys = new Set<string>();
  let collisions = 0;

    // Buffered rather than one write per row: hundreds of thousands of separate
    // writes cost far more than the memory this holds.
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
        // Per-row size measured from the live table, data and indexes together.
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

    // Merge rather than overwrite. Rebuilding one variant is normal, and a full
    // rewrite would silently drop the other's record while the file still looked
    // complete. This file is the committed record, so a half-written one is worse
    // than a missing one.
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
