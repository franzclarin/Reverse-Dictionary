/**
 * Fill the live meaning-based search index.
 *
 * Groups the dictionary's entries by meaning, measures each one's definition
 * with the SAME code the live site uses — never a copy, since a second way of
 * measuring would make every number fiction — and writes one row per meaning.
 *
 * `--dry-run` measures and checks without writing anything. The real insert
 * needs the table to already exist, and is a deliberate hard stop this script
 * will not cross unattended. Do not point this at the live database and drop the
 * flag without confirming first.
 *
 *   npx tsx scripts/build-gloss-index.ts --dry-run
 *   npx tsx scripts/build-gloss-index.ts              # writes to DATABASE_URL — confirm first
 */
import { PrismaClient } from "@prisma/client";
import { embed } from "@/lib/embedder";
import { loadEnv } from "./lib/env";
import { POS_LIST, readSenses } from "./lib/wordnet";

loadEnv();

const prisma = new PrismaClient();

const BATCH_SIZE = 500;
// A sanity check rather than a requirement; a dictionary version change could
// legitimately move this.
const EXPECTED_SYNSET_COUNT = 114_662;

type SynsetGroup = {
  synsetKey: string;
  pos: string;
  gloss: string;
    /** The dictionary's own word order. Never sort it. */
  lemmas: string[];
};

function groupBySynset(): SynsetGroup[] {
  const groups: SynsetGroup[] = [];
  for (const pos of POS_LIST) {
    for (const sense of readSenses(pos)) {
      groups.push({
        synsetKey: `${sense.pos}:${sense.offset}`,
        pos: sense.pos,
        gloss: sense.gloss,
        lemmas: sense.words,
      });
    }
  }
  return groups;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  console.log("Reading WordNet senses...");
  const groups = groupBySynset();
  console.log(`  ${groups.length.toLocaleString()} synsets across ${POS_LIST.join(", ")}`);
  if (groups.length !== EXPECTED_SYNSET_COUNT) {
    console.warn(
      `  NOTE: expected ~${EXPECTED_SYNSET_COUNT.toLocaleString()} synsets per CLAUDE.md's ` +
        `Phase E count; got ${groups.length.toLocaleString()}. Not necessarily wrong ` +
        `(wordnet-db version drift is possible) but worth checking before a real run.`
    );
  }

  console.log(`\nEmbedding ${groups.length.toLocaleString()} gloss texts with the production embedder...`);
  const embedded: { group: SynsetGroup; vector: number[] }[] = [];
  const startedAt = Date.now();
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const vector = await embed(group.gloss);
    embedded.push({ group, vector });
    if ((i + 1) % 1000 === 0 || i === groups.length - 1) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`  ${(i + 1).toLocaleString()}/${groups.length.toLocaleString()} embedded (${elapsed}s elapsed)`);
    }
  }

  if (dryRun) {
    const sample = embedded[0];
    console.log(
      `\n--dry-run: embedded ${embedded.length.toLocaleString()} synsets, nothing written to the database.`
    );
    console.log("Sample row:", {
      synsetKey: sample.group.synsetKey,
      pos: sample.group.pos,
      gloss: sample.group.gloss,
      lemmas: sample.group.lemmas,
      dims: sample.vector.length,
    });
    return;
  }

  console.log(
    `\nThis will write ${embedded.length.toLocaleString()} rows to "GlossEmbedding". That table only ` +
      `fits alongside VocabEmbedding's existing IVFFlat index once that index has been dropped (see the ` +
      `commented-out DROP INDEX in this table's migration file) — confirm that has been done deliberately, ` +
      `not by this script, before running for real.`
  );

    // One insert per batch. Doing them one row at a time measured at about a
    // minute and a half per batch, which projected to roughly six hours.
  for (let i = 0; i < embedded.length; i += BATCH_SIZE) {
    const batch = embedded.slice(i, i + BATCH_SIZE);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach(({ group, vector }, idx) => {
      const base = idx * 5;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::text[], $${base + 5}::halfvec)`);
      params.push(group.synsetKey, group.pos, group.gloss, group.lemmas, `[${vector.join(",")}]`);
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "GlossEmbedding" ("synsetKey", "pos", "gloss", "lemmas", "embedding")
       VALUES ${values.join(",\n              ")}
       ON CONFLICT ("synsetKey") DO UPDATE SET
         "pos" = EXCLUDED."pos",
         "gloss" = EXCLUDED."gloss",
         "lemmas" = EXCLUDED."lemmas",
         "embedding" = EXCLUDED."embedding"`,
      ...params
    );
    console.log(
      `  inserted ${Math.min(i + BATCH_SIZE, embedded.length).toLocaleString()}/${embedded.length.toLocaleString()}`
    );
  }

  const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "GlossEmbedding"`
  );
  console.log(`\nDone. "GlossEmbedding" now has ${count.toLocaleString()} rows.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
