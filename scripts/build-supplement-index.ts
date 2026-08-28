/**
 * RD-17 step 6 — insert the measured supplement into the production index.
 *
 * ONLY RUN THIS PAST THE GATE. Steps 4 and 5 exist so the decision is made on a
 * local cell at zero production exposure, exactly as RD-12's reranker and
 * RD-16's encoder sweep were — and both of those ended in "nothing shipped".
 * Read eval/METHODS.md §15 before running it.
 *
 * THE VECTORS COME FROM THE CELL THAT WAS MEASURED, not from a re-embed. Two
 * reasons, and the second is the important one:
 *
 *   - Re-encoding half a million glosses to get the same numbers is an hour
 *     spent proving the encoder is deterministic.
 *   - A re-embed is a second embedding path in disguise. If anything differed —
 *     a model revision, a changed text variant, a reordered manifest — the table
 *     would hold vectors no eval run ever scored, and every number in §15 would
 *     describe something other than what shipped. The cell has an input hash and
 *     a prefix-identity check behind it; that is the artifact to trust.
 *
 * INSERT ONLY. The 117,791 WordNet rows are not touched, not rewritten, and not
 * re-embedded — their vectors are bit-identical before and after, so the
 * rollback is `DELETE FROM "GlossEmbedding" WHERE "synsetKey" LIKE 'wikt:%'`
 * and the pre-expansion index is exactly restored.
 *
 * AFTER INSERTING, REBUILD THE IVFFLAT INDEX. `lists = 115` was tuned for
 * 117,791 rows and is wrong for the new count, and `GLOSS_PROBES = 40` is only
 * meaningful as a fraction of `lists`. The script prints the statement and the
 * probe sweep to run; it does not rebuild the index unattended, because that is
 * a minutes-long exclusive operation on the table serving production.
 *
 *   npx tsx scripts/build-supplement-index.ts --cell full_gloss_wikt_new --dry-run
 *   npx tsx scripts/build-supplement-index.ts --cell full_gloss_wikt_new --confirm
 *   npx tsx scripts/build-supplement-index.ts --rollback --confirm
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { cellDir, loadIndex, DIM } from "./lib/localIndex";
import { GLOSS_INDEX } from "../lib/glossSearch";

loadEnv();

const prisma = new PrismaClient();

/** Matches `build-gloss-index.ts`: one multi-row INSERT per batch, not 500 round trips. */
const BATCH_SIZE = 500;

/** Namespace prefix every supplement key carries. The rollback predicate. */
const KEY_PREFIX = "wikt:";

type ManifestRow = { key: string; word: string; text: string; source: string };

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function readManifest(file: string): Promise<ManifestRow[]> {
  const rows: ManifestRow[] = [];
  const stream = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of stream) if (line) rows.push(JSON.parse(line) as ManifestRow);
  return rows;
}

async function rollback(confirm: boolean): Promise<void> {
  const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "${GLOSS_INDEX}" WHERE "synsetKey" LIKE '${KEY_PREFIX}%'`
  );
  console.log(`\n  ${count.toLocaleString()} supplement rows in "${GLOSS_INDEX}"`);
  if (!confirm) {
    console.log(`  --confirm to delete them. The WordNet rows are untouched either way.\n`);
    return;
  }
  const deleted = await prisma.$executeRawUnsafe(
    `DELETE FROM "${GLOSS_INDEX}" WHERE "synsetKey" LIKE '${KEY_PREFIX}%'`
  );
  console.log(`  deleted ${deleted.toLocaleString()} rows. Rebuild the IVFFlat index for the new count.\n`);
}

async function main(): Promise<void> {
  console.log("\nRD-17 · supplement -> production index\n");

  if (has("--rollback")) {
    await rollback(has("--confirm"));
    return;
  }

  const cellName = arg("--cell");
  if (!cellName) {
    console.error("--cell <name> is required (the cell whose numbers justified this).");
    process.exitCode = 1;
    return;
  }

  const dir = cellDir();
  const idx = loadIndex(cellName, dir);
  const manifest = await readManifest(path.join(dir, `${cellName}.manifest.jsonl`));
  if (manifest.length !== idx.meta.rows) {
    throw new Error(`manifest has ${manifest.length} rows, cell has ${idx.meta.rows}`);
  }

  // The gloss text per key, straight from the filtered source, so the column and
  // the vector describe the same sense.
  const supplement = manifest
    .map((row, i) => ({ ...row, row: i }))
    .filter((r) => r.source === "wiktionary");

  const [{ count: before }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "${GLOSS_INDEX}"`
  );

  console.log(`  cell          ${cellName}  (${idx.meta.supplementArm ?? "?"}, filter ${idx.meta.filterVersion ?? "?"})`);
  console.log(`  vectors       ${idx.meta.rows.toLocaleString()} rows x ${idx.meta.dim}d`);
  console.log(`  supplement    ${supplement.length.toLocaleString()} rows to insert`);
  console.log(`  ${GLOSS_INDEX}  ${before.toLocaleString()} rows now -> ${(Number(before) + supplement.length).toLocaleString()} after`);

  if (idx.meta.dim !== DIM) {
    throw new Error(`cell is ${idx.meta.dim}-dim; the column is halfvec(${DIM})`);
  }

  if (!has("--confirm")) {
    console.log(
      `\n  --dry-run: nothing written. Pass --confirm to insert.\n` +
        `  Sample row: ${JSON.stringify({
          synsetKey: supplement[0]?.key,
          gloss: supplement[0]?.text.slice(0, 70),
          lemmas: [supplement[0]?.word],
        })}\n`
    );
    return;
  }

  const started = Date.now();
  for (let i = 0; i < supplement.length; i += BATCH_SIZE) {
    const batch = supplement.slice(i, i + BATCH_SIZE);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((r, n) => {
      const base = n * 5;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::text[], $${base + 5}::halfvec)`);
      const vector = Array.from(idx.data.subarray(r.row * DIM, (r.row + 1) * DIM));
      // `pos` mirrors the WordNet rows' vocabulary (noun/verb/adj/adv); the
      // Wiktionary filter keeps only those four, so nothing new appears here.
      params.push(r.key, r.key.split(":")[2] ?? "", r.text, [r.word], `[${vector.join(",")}]`);
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${GLOSS_INDEX}" ("synsetKey", "pos", "gloss", "lemmas", "embedding")
       VALUES ${values.join(",\n              ")}
       ON CONFLICT ("synsetKey") DO UPDATE SET
         "pos" = EXCLUDED."pos",
         "gloss" = EXCLUDED."gloss",
         "lemmas" = EXCLUDED."lemmas",
         "embedding" = EXCLUDED."embedding"`,
      ...params
    );
    if ((i / BATCH_SIZE) % 20 === 0 || i + BATCH_SIZE >= supplement.length) {
      const done = Math.min(i + BATCH_SIZE, supplement.length);
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(
        `\r  inserted ${done.toLocaleString()}/${supplement.length.toLocaleString()}  ` +
          `eta ${((supplement.length - done) / rate / 60).toFixed(1)}m    `
      );
    }
  }

  const [{ count: after }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "${GLOSS_INDEX}"`
  );
  const [{ size }] = await prisma.$queryRawUnsafe<{ size: string }[]>(
    `SELECT pg_size_pretty(pg_total_relation_size('"${GLOSS_INDEX}"')) AS size`
  );
  const lists = Math.round(Math.sqrt(Number(after)));
  console.log(`\n\n  "${GLOSS_INDEX}" now has ${after.toLocaleString()} rows, ${size}`);
  console.log(
    `\n  NEXT, and the run is not finished without it — the IVFFlat index is still built for\n` +
      `  ${before.toLocaleString()} rows, so probes=40 no longer means what it meant:\n\n` +
      `    DROP INDEX "${GLOSS_INDEX}_embedding_ivfflat_idx";\n` +
      `    CREATE INDEX "${GLOSS_INDEX}_embedding_ivfflat_idx" ON "${GLOSS_INDEX}"\n` +
      `      USING ivfflat (embedding halfvec_cosine_ops) WITH (lists = ${lists});\n\n` +
      `  then sweep probes and update GLOSS_PROBES/GLOSS_LISTS in lib/glossSearch.ts:\n\n` +
      `    for p in 10 40 100 200; do npx tsx scripts/eval.ts --set eval/sets/v1.jsonl \\\n` +
      `      --index ${GLOSS_INDEX} --probes $p --tag rd17_prod_p$p; done\n\n` +
      `  Rollback, if needed:  npx tsx scripts/build-supplement-index.ts --rollback --confirm\n`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
