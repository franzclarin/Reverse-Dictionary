/**
 * Build `eval/sets/v1.jsonl` from the reviewed TSV plus the gloss tripwire.
 *
 * The authored slice comes from a human-edited TSV, never from the draft this
 * repo generated. Pass `--tsv <file>`; omit it to build the tripwire slice
 * alone, which is what the Phase C smoke test runs on.
 *
 * The tripwire is derived, not authored: `Word.definition` rows written during
 * the era when word pages had generated profiles. Those definitions are not
 * WordNet gloss text, but they describe words the fine-tune saw glossed, so
 * they leak at the paraphrase level. Hence `meta.leakage: "paraphrase"` and the
 * standing rule that this slice is never a headline number.
 *
 *   npx tsx scripts/build-eval-set.ts --tsv eval/sets/v1-reviewed.tsv
 *   npx tsx scripts/build-eval-set.ts --tripwire-only --out eval/sets/tripwire.jsonl
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { loadZipf } from "./lib/freq";

loadEnv();

const prisma = new PrismaClient();

export type EvalSource = "authored" | "gloss_tripwire";

export type EvalMeta = {
  sense_hint?: string;
  zipf?: number;
  token_count: "single" | "multi";
  style?: string;
  lexical_overlap?: "none" | "stem_shared" | "head_noun";
  reachable: boolean;
  acceptable: string[];
  leakage?: "paraphrase";
};

export type EvalRow = {
  id: string;
  query: string;
  target: string;
  source: EvalSource;
  meta: EvalMeta;
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Columns the reviewed TSV must have for the parse to mean anything. */
const REQUIRED_COLUMNS = ["target", "query"];

function parseTsv(file: string): Record<string, string>[] {
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    // Comment lines are emitted with a QUOTED first cell, so they begin with
    // `"#` rather than `#`. Matching only `#` made the first comment line the
    // header, which silently produced zero authored rows and a frozen set
    // containing nothing but the quarantined tripwire.
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith('"#'));
  const header = lines[0].split("\t");

  const missing = REQUIRED_COLUMNS.filter((c) => !header.map((h) => h.trim()).includes(c));
  if (missing.length) {
    throw new Error(
      `TSV header is missing ${missing.join(", ")}. Parsed header was:\n  ${header.join(" | ")}\n` +
        `This usually means a comment line was mistaken for the header.`
    );
  }

  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h.trim()] = (cells[i] ?? "").trim()));
    return row;
  });
}

function splitAcceptable(cell: string): string[] {
  return cell
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function buildAuthored(file: string): Promise<EvalRow[]> {
  const zipf = loadZipf();
  const rows = parseTsv(file);
  const out: EvalRow[] = [];

  let n = 0;
  for (const row of rows) {
    if (!row.target || !row.query) continue;
    n++;

    // Trust the reviewed file for content, but recompute anything derivable so
    // an edited query can't carry stale metadata.
    const rawZipf = row.zipf ? Number(row.zipf) : zipf.get(row.target.toLowerCase());
    out.push({
      id: `authored-${String(n).padStart(4, "0")}`,
      query: row.query,
      target: row.target,
      source: "authored",
      meta: {
        sense_hint: row.sense_hint || undefined,
        zipf: Number.isFinite(rawZipf as number) ? (rawZipf as number) : undefined,
        token_count: /[ _-]/.test(row.target) ? "multi" : "single",
        style: row.style || undefined,
        lexical_overlap: (row.lexical_overlap as EvalMeta["lexical_overlap"]) || "none",
        // Case-insensitive: the reviewed TSV writes TRUE/FALSE, and comparing
        // against lowercase "false" silently marked all 25 coverage rows
        // reachable — which would have counted deliberately-absent targets as
        // headline misses.
        reachable: !/^(false|0|no)$/i.test((row.reachable ?? "").trim()),
        acceptable: splitAcceptable(row.acceptable ?? ""),
      },
    });
  }
  return out;
}

async function buildTripwire(): Promise<EvalRow[]> {
  const zipf = loadZipf();

  // Same exclusions as every other slice: query at least three words, query
  // must not contain the target, target must be reachable. Case-insensitive
  // vocabulary match — this is a tripwire, precision there does not matter.
  const rows = await prisma.$queryRawUnsafe<{ word: string; definition: string }[]>(
    `SELECT w.word, w.definition
       FROM "Word" w
      WHERE w.definition <> ''
        AND array_length(regexp_split_to_array(trim(w.definition), '\\s+'), 1) >= 3
        AND w.definition !~* ('\\m' || w.word || '\\M')
        AND EXISTS (
          SELECT 1 FROM "VocabEmbedding" v WHERE lower(v.word) = lower(w.word)
        )
      ORDER BY w.word`
  );

  return rows.map((r, i) => ({
    id: `tripwire-${String(i + 1).padStart(4, "0")}`,
    query: r.definition.trim(),
    target: r.word,
    source: "gloss_tripwire" as const,
    meta: {
      zipf: zipf.get(r.word.toLowerCase()),
      token_count: (/[ _-]/.test(r.word) ? "multi" : "single") as "single" | "multi",
      reachable: true,
      acceptable: [],
      leakage: "paraphrase" as const,
    },
  }));
}

async function main(): Promise<void> {
  const tsv = arg("--tsv");
  const tripwireOnly = process.argv.includes("--tripwire-only");
  const outPath = path.resolve(
    process.cwd(),
    arg("--out") ?? (tripwireOnly ? "eval/sets/tripwire.jsonl" : "eval/sets/v1.jsonl")
  );

  if (!tsv && !tripwireOnly) {
    console.error(
      "Refusing to build v1.jsonl without a reviewed TSV.\n" +
        "  npx tsx scripts/build-eval-set.ts --tsv <reviewed.tsv>\n" +
        "  npx tsx scripts/build-eval-set.ts --tripwire-only"
    );
    process.exitCode = 1;
    return;
  }

  const rows: EvalRow[] = [];
  if (tsv) {
    const full = path.resolve(process.cwd(), tsv);
    if (!fs.existsSync(full)) {
      console.error(`No such TSV: ${tsv}`);
      process.exitCode = 1;
      return;
    }
    rows.push(...(await buildAuthored(full)));
  }
  rows.push(...(await buildTripwire()));

  // A --tsv build that yields no authored rows is always a parse failure, never
  // a legitimate outcome. Writing it would freeze a set whose only content is
  // the quarantined slice, under a filename claiming otherwise.
  if (tsv && !rows.some((r) => r.source === "authored")) {
    console.error(
      "Refusing to write: --tsv was given but the authored slice is empty.\n" +
        "The TSV parsed to zero usable rows — check the header row and column names."
    );
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(outPath, body, "utf8");

  const sha = crypto.createHash("sha256").update(body).digest("hex");

  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
  console.log(`  rows        ${rows.length}`);
  for (const source of ["authored", "gloss_tripwire"] as EvalSource[]) {
    const slice = rows.filter((r) => r.source === source);
    if (!slice.length) continue;
    const reachable = slice.filter((r) => r.meta.reachable).length;
    const withAcceptable = slice.filter((r) => r.meta.acceptable.length > 0).length;
    console.log(
      `  ${source.padEnd(14)} ${String(slice.length).padStart(4)}   ` +
        `reachable ${reachable}   with acceptable[] ${withAcceptable}`
    );
  }
  console.log(`\n  sha256  ${sha}`);
  console.log(`\n  This file is frozen from here. A new version means a new filename.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
