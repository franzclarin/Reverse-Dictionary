/**
 * Populate the production synset-keyed gloss index ("GlossEmbedding",
 * halfvec(384)) — CLAUDE.md's first "Next steps" item.
 *
 * Groups WordNet 3.0 senses by synset (pos:offset), embeds each synset's
 * definition text with the SAME production embedder /api/lookup uses (never
 * a reimplementation — a second embedding path would make every number
 * fiction, the same rule the eval harness already enforces), and upserts one
 * row per synset. Mirrors scripts/build-synset-cell.ts's grouping logic, but
 * targets Postgres directly instead of a local eval cell — production only
 * needs the per-synset collapse itself, not a re-proof that it's lossless
 * (Phase E already established that: 0 discordant pairs, mean cosine
 * 0.99999998 against the per-sense version).
 *
 * --dry-run embeds and validates without writing to the database. This is
 * the ONLY mode this migration audit actually ran (see MIGRATION_AUDIT.md).
 * The real insert phase requires GlossEmbedding's table to already exist
 * (prisma/migrations/20260822000000_add_gloss_embeddings/migration.sql) AND,
 * in production, VocabEmbedding's IVFFlat index to already be dropped to fit
 * Neon's 512MB ceiling — both are a deliberate hard-stop this script does not
 * cross unattended. Do not point DATABASE_URL at production and drop the
 * --dry-run flag without explicit confirmation first.
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
// Phase E's build (CLAUDE.md, "Next steps") — a sanity check, not a hard
// requirement; wordnet-db version drift could legitimately move this.
const EXPECTED_SYNSET_COUNT = 114_662;

type SynsetGroup = {
  synsetKey: string;
  pos: string;
  gloss: string;
  /** WordNet's own within-synset order — see the schema comment on `lemmas`. */
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

  for (let i = 0; i < embedded.length; i += BATCH_SIZE) {
    const batch = embedded.slice(i, i + BATCH_SIZE);
    await prisma.$transaction(
      batch.map(({ group, vector }) => {
        const vectorLiteral = `[${vector.join(",")}]`;
        return prisma.$executeRawUnsafe(
          `INSERT INTO "GlossEmbedding" ("synsetKey", "pos", "gloss", "lemmas", "embedding")
           VALUES ($1, $2, $3, $4::text[], $5::halfvec)
           ON CONFLICT ("synsetKey") DO UPDATE SET
             "pos" = EXCLUDED."pos",
             "gloss" = EXCLUDED."gloss",
             "lemmas" = EXCLUDED."lemmas",
             "embedding" = EXCLUDED."embedding"`,
          group.synsetKey,
          group.pos,
          group.gloss,
          group.lemmas,
          vectorLiteral
        );
      })
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
