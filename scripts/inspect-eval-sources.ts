/**
 * A first look at the live database: what is actually in it, and does anything
 * hold (description -> word) pairs a test set could be built from?
 *
 * Reads only; changes nothing.
 *   npx tsx scripts/inspect-eval-sources.ts
 */
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";

loadEnv();

const prisma = new PrismaClient();

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
};

function heading(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

async function listTables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

async function describeColumns(tables: string[]): Promise<ColumnRow[]> {
  return prisma.$queryRawUnsafe<ColumnRow[]>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    tables
  );
}

async function countRows(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "${table}"`
  );
  return Number(rows[0].n);
}

/** Any free-text column is somewhere a stored question could be hiding. */
async function findTextColumns(): Promise<ColumnRow[]> {
  return prisma.$queryRawUnsafe<ColumnRow[]>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('text', 'character varying', 'character')
      ORDER BY table_name, ordinal_position`
  );
}

async function sample(table: string, limit = 5): Promise<unknown[]> {
  try {
    return await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM "${table}" ORDER BY 1 LIMIT ${limit}`
    );
  } catch (error) {
    return [{ error: (error as Error).message }];
  }
}

function printRows(rows: unknown[]): void {
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  for (const row of rows) {
    console.log(
      "  " +
        JSON.stringify(row, (_key, value) =>
          typeof value === "bigint" ? Number(value) : value
        )
    );
  }
}

async function main(): Promise<void> {
  heading("Tables in public schema");
  const tables = await listTables();
  for (const table of tables) {
    console.log(`  ${table.padEnd(24)} ${await countRows(table)} rows`);
  }

  heading("Columns (all app tables)");
  const columns = await describeColumns(tables);
  let current = "";
  for (const col of columns) {
    if (col.table_name !== current) {
      current = col.table_name;
      console.log(`\n  ${current}`);
    }
    const type = col.udt_name === "vector" ? "vector" : col.data_type;
    console.log(
      `    ${col.column_name.padEnd(18)} ${type.padEnd(26)} ${
        col.is_nullable === "YES" ? "nullable" : "not null"
      }`
    );
  }

  heading("Every free-text column in the database");
  console.log(
    "  (a stored user query would have to live in one of these)\n"
  );
  for (const col of await findTextColumns()) {
    console.log(
      `  ${col.table_name}.${col.column_name.padEnd(18)} ${col.data_type}`
    );
  }

  heading("Sample rows");
  for (const table of tables) {
    if (table === "VocabEmbedding") continue; // 384-float column, sampled separately
    console.log(`\n  ${table}:`);
    printRows(await sample(table));
  }

  console.log(`\n  VocabEmbedding (word only):`);
  printRows(
    await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT id, word FROM "VocabEmbedding" ORDER BY id LIMIT 5`
    )
  );

  heading("Yield estimates per candidate source");

  // --- Source A: Lookup (would need query text) ---
  const lookupCols = columns
    .filter((c) => c.table_name === "Lookup")
    .map((c) => c.column_name);
  const lookupHasText = columns.some(
    (c) =>
      c.table_name === "Lookup" &&
      ["text", "character varying"].includes(c.data_type) &&
      !["id", "userId"].includes(c.column_name)
  );
  console.log(`\n  Lookup`);
  console.log(`    columns: ${lookupCols.join(", ")}`);
  console.log(`    stores query text? ${lookupHasText ? "YES" : "NO"}`);

  // --- Source B: Lookup x SavedWord temporal join ---
  if (tables.includes("Lookup") && tables.includes("SavedWord")) {
    const [{ n: lookups }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "Lookup"`
    );
    const [{ n: saves }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "SavedWord"`
    );
    const [{ n: pairs }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n
         FROM "SavedWord" s
         JOIN "Lookup" l
           ON l."userId" = s."userId"
          AND l."createdAt" <= s."savedAt"
          AND l."createdAt" > s."savedAt" - interval '5 minutes'`
    );
    console.log(`\n  Lookup x SavedWord (save within 5 min of a lookup)`);
    console.log(`    lookups: ${Number(lookups)}`);
    console.log(`    saves:   ${Number(saves)}`);
    console.log(`    temporally joinable pairs: ${Number(pairs)}`);
  }

  // --- Source C: GameRound ---
  if (tables.includes("GameRound")) {
    const games = await prisma.$queryRawUnsafe<{ game: string; n: bigint }[]>(
      `SELECT game, count(*)::bigint AS n FROM "GameRound" GROUP BY game ORDER BY n DESC`
    );
    console.log(`\n  GameRound`);
    console.log(
      `    columns: ${columns
        .filter((c) => c.table_name === "GameRound")
        .map((c) => c.column_name)
        .join(", ")}`
    );
    console.log(`    distinct games:`);
    for (const g of games) console.log(`      ${g.game}: ${Number(g.n)}`);
  }

  // --- Source D: Word definitions as glosses ---
  if (tables.includes("Word")) {
    const [stats] = await prisma.$queryRawUnsafe<
      {
        total: bigint;
        with_def: bigint;
        def_3plus_words: bigint;
        in_vocab: bigint;
        usable: bigint;
      }[]
    >(
      `SELECT count(*)::bigint                                                        AS total,
              count(*) FILTER (WHERE definition <> '')::bigint                        AS with_def,
              count(*) FILTER (
                WHERE definition <> ''
                  AND array_length(regexp_split_to_array(trim(definition), '\\s+'), 1) >= 3
              )::bigint                                                               AS def_3plus_words,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM "VocabEmbedding" v WHERE lower(v.word) = lower(w.word)
              ))::bigint                                                              AS in_vocab,
              count(*) FILTER (
                WHERE definition <> ''
                  AND array_length(regexp_split_to_array(trim(definition), '\\s+'), 1) >= 3
                  AND definition !~* ('\\m' || w.word || '\\M')
                  AND EXISTS (SELECT 1 FROM "VocabEmbedding" v WHERE lower(v.word) = lower(w.word))
              )::bigint                                                               AS usable
         FROM "Word" w`
    );
    console.log(`\n  Word (definitions as glosses)`);
    console.log(`    total rows:                        ${Number(stats.total)}`);
    console.log(`    with a non-empty definition:       ${Number(stats.with_def)}`);
    console.log(`    ... and >= 3 words long:           ${Number(stats.def_3plus_words)}`);
    console.log(`    words present in VocabEmbedding:   ${Number(stats.in_vocab)}`);
    console.log(`    usable after all exclusions:       ${Number(stats.usable)}`);
  }

  heading("Vocabulary provenance");
    // If the index is the dictionary's word list, then that dictionary's own
    // definitions are not a fair test source — the model was trained on them.
  const probes = [
    "correlation",
    "moaner",
    "bellow",
    "American pulsatilla",
    "genus Pulsatilla",
    "damascene",
    "Damascene",
    "Peary",
    "pear tree",
    "champion lode",
    "international mile",
    "betatron",
    "southern spatterdock",
    "crane fly",
    "petrichor",
    "metafiction",
    "sonder",
    "rizz",
  ];
  const hits = new Set(
    (
      await prisma.$queryRawUnsafe<{ word: string }[]>(
        `SELECT word FROM "VocabEmbedding" WHERE word = ANY($1::text[])`,
        probes
      )
    ).map((r) => r.word)
  );
  console.log("\n  Probe words drawn from the model card's own training samples:");
  for (const p of probes) console.log(`    ${hits.has(p) ? "HIT " : "miss"}  ${p}`);

  const [shape] = await prisma.$queryRawUnsafe<
    { multiword: bigint; capitalised: bigint; lower_collisions: bigint }[]
  >(
    `SELECT count(*) FILTER (WHERE word LIKE '% %')::bigint  AS multiword,
            count(*) FILTER (WHERE word ~ '^[A-Z]')::bigint  AS capitalised,
            (SELECT count(*)::bigint FROM (
               SELECT lower(word) FROM "VocabEmbedding" GROUP BY 1 HAVING count(*) > 1
             ) t)                                            AS lower_collisions
       FROM "VocabEmbedding"`
  );
  console.log(`\n  multi-word entries:            ${Number(shape.multiword)}`);
  console.log(`  capitalised entries:           ${Number(shape.capitalised)}`);
  console.log(`  lemmas colliding on lower():   ${Number(shape.lower_collisions)}`);

  heading("Word rows reachable from SavedWord");
  const saved = await prisma.$queryRawUnsafe<
    { word: string; definition_empty: boolean }[]
  >(
    `SELECT w.word, (w.definition = '') AS definition_empty
       FROM "SavedWord" s JOIN "Word" w ON w.id = s."wordId"
      ORDER BY w.word`
  );
  for (const r of saved) {
    console.log(
      `  ${r.word}${r.definition_empty ? "   [minimal row — no definition]" : ""}`
    );
  }

  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
