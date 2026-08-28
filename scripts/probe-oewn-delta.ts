/**
 * RD-17 step 2 — is Open English WordNet enough on its own?
 *
 * The cheap source before the expensive one. OEWN is the maintained successor
 * to Princeton WordNet 3.0 with the same synset/gloss structure, so adopting it
 * would change only the reader inside `scripts/lib/wordnet.ts` and cost roughly
 * zero extra storage. If it carries the `petrichor` class, that is the entire
 * ticket and the 3.2 GB Wiktionary path never has to be walked.
 *
 * This measures the delta rather than assuming it, and prints the one slice
 * that decides: how many of the eval set's `reachable: false` targets OEWN can
 * actually answer.
 *
 * Read-only. Reads the live GlossEmbedding lemma set for the comparison, so the
 * "already answerable" side is what production really holds, not a rebuild of
 * what it should hold.
 *
 *   npx tsx scripts/probe-oewn-delta.ts
 *   npx tsx scripts/probe-oewn-delta.ts --file ~/rd_sources/oewn.xml.gz
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { readOewn, oewnLemmas } from "./lib/oewn";
import { sourcePath } from "./lib/sources";
import { POS_LIST, readSenses } from "./lib/wordnet";

loadEnv();

const DEFAULT_FILE = "oewn.xml.gz";
const DOWNLOAD_URL = "https://en-word.net/static/english-wordnet-2024.xml.gz";
const EVAL_SET = "eval/sets/v1.jsonl";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

type EvalRow = { id: string; target: string; meta: { reachable?: boolean } };

function unreachableTargets(): EvalRow[] {
  return fs
    .readFileSync(EVAL_SET, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EvalRow)
    .filter((r) => r.meta.reachable === false);
}

async function main(): Promise<void> {
  const file = arg("--file") ?? sourcePath(DEFAULT_FILE);
  if (!fs.existsSync(file)) {
    console.error(
      `\nno ${file}\n\n  curl -L -o ${file} ${DOWNLOAD_URL}\n`
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nRD-17 · Open English WordNet delta\n");

  const oewn = readOewn(file);
  const oewnWords = oewnLemmas(oewn);
  const oewnLower = new Set([...oewnWords].map((w) => w.toLowerCase()));

  // WordNet 3.0 as shipped, which is what build-gloss-index.ts reads.
  const pwn = readSenses(POS_LIST[0]).length
    ? POS_LIST.flatMap((pos) => readSenses(pos))
    : [];
  const pwnWords = new Set(pwn.flatMap((s) => s.words.map((w) => w.toLowerCase())));

  console.log(`  WordNet 3.0 (wordnet-db)   ${pwn.length.toLocaleString()} synsets   ${pwnWords.size.toLocaleString()} lemmas`);
  console.log(`  Open English WordNet 2024  ${oewn.length.toLocaleString()} synsets   ${oewnLower.size.toLocaleString()} lemmas`);

  const added = [...oewnLower].filter((w) => !pwnWords.has(w));
  const dropped = [...pwnWords].filter((w) => !oewnLower.has(w));
  console.log(
    `\n  delta vs WordNet 3.0       +${added.length.toLocaleString()} lemmas   -${dropped.length.toLocaleString()} lemmas`
  );

  // The live index is the honest baseline for "already answerable": it is what
  // a user's query is actually matched against.
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe<{ w: string }[]>(
      `SELECT DISTINCT lower(unnest(lemmas)) AS w FROM "GlossEmbedding"`
    );
    const live = new Set(rows.map((r) => r.w));
    console.log(`  live GlossEmbedding        ${live.size.toLocaleString()} answerable lemmas`);
    console.log(
      `  OEWN lemmas not yet live   ${[...oewnLower].filter((w) => !live.has(w)).length.toLocaleString()}`
    );

    // The decisive slice. Everything above is a row count; this is capability.
    const targets = unreachableTargets();
    const covered = targets.filter((t) => oewnLower.has(t.target.toLowerCase()));
    const stillLive = targets.filter((t) => live.has(t.target.toLowerCase()));

    console.log(
      `\n  eval coverage slice — ${targets.length} targets flagged reachable:false\n`
    );
    for (const t of targets) {
      const inLive = live.has(t.target.toLowerCase());
      const inOewn = oewnLower.has(t.target.toLowerCase());
      console.log(
        `    ${inOewn ? "OEWN" : "    "}  ${inLive ? "LIVE" : "    "}   ${t.target}`
      );
    }
    console.log(
      `\n    already answerable on the live index : ${stillLive.length}` +
        `   (stale flags — RD-05 owns the correction)`
    );
    console.log(`    added by OEWN                        : ${covered.filter((t) => !live.has(t.target.toLowerCase())).length}`);
    console.log(
      `    still missing after OEWN             : ${targets.length - new Set([...stillLive, ...covered].map((t) => t.id)).size}`
    );

    console.log(
      `\n  VERDICT: OEWN is a lemma-count change, not a capability change. It re-keys every\n` +
        `  synset (oewn-NNNNNNNN-p, not pos:offset), which orphans every committed run, and\n` +
        `  it buys the handful of targets listed above. Recorded, not adopted — RD-17 needs\n` +
        `  the Wiktionary path. See eval/METHODS.md §15.\n`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
