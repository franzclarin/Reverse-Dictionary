/**
 * Build the frozen question set from the reviewed file plus the tripwire rows.
 *
 * The hand-written questions come from a human-edited file, never from the draft
 * this repo generated. Leaving out that file builds the tripwire rows alone,
 * which is what the smoke test runs on.
 *
 * The tripwire rows are not hand-written: they are paraphrased from stored
 * definitions, which describe words the model was trained on. So they leak, they
 * are labelled as leaking, and they are never a headline number.
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

/** Columns the reviewed file must have for the parse to mean anything. */
const REQUIRED_COLUMNS = ["target", "query"];

function parseTsv(file: string): Record<string, string>[] {
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
        // Comment lines start with a quote mark before the hash. Matching the hash
        // alone made the first comment the header, which silently produced zero
        // hand-written rows and a set containing only the quarantined ones.
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

        // Trust the reviewed file for wording, but recompute anything derivable, so
        // an edited question cannot carry stale details.
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
                // Compared ignoring case: the file writes TRUE/FALSE, and matching only
                // lowercase silently marked every deliberately-missing word as findable,
                // which would have counted them as headline failures.
        reachable: !/^(false|0|no)$/i.test((row.reachable ?? "").trim()),
        acceptable: splitAcceptable(row.acceptable ?? ""),
      },
    });
  }
  return out;
}

async function buildTripwire(): Promise<EvalRow[]> {
  const zipf = loadZipf();

    // Same rules as everywhere else: at least three words, must not contain its
    // own answer, answer must be findable.
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

    // A build that yields no hand-written rows is always a parse failure, never a
    // real outcome. Writing it would freeze a set containing only the quarantined
    // rows, under a filename claiming otherwise.
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
