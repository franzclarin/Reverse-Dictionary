import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Shadow-log a lookup: query the (not-yet-cut-over) GlossEmbedding index
 * alongside the production VocabEmbedding one, and record whether their
 * top-1 answers agree. This is the data CLAUDE.md's "Next steps" section
 * says the cutover decision is gated on — real production traffic, not just
 * the 287-query hand-authored eval set.
 *
 * Deliberately logs a hash of the query, not the query text itself,
 * preserving the "no query text has ever been logged" property CLAUDE.md
 * documents as a deliberate stance. Deliberately logs only each system's
 * top-1 answer, not full top-k or the embedding vector — enough to measure
 * AGREEMENT RATE between the two systems, not enough to reconstruct a full
 * paired accuracy comparison. That comparison isn't available from shadow
 * data no matter how much is logged, since production traffic has no
 * labelled target — see scripts/shadow-compare.ts's header comment.
 *
 * NOT YET CALLED from app/api/lookup/route.ts and NOT YET APPLIED as a
 * migration — see MIGRATION_AUDIT.md. When wired in, the caller must never
 * await this before responding and must always wrap it in .catch(): a
 * GlossEmbedding failure (e.g. the table not existing yet) must never affect
 * the user-facing lookup response.
 */
export async function runShadowLookup(
  query: string,
  vectorLiteral: string,
  oldTop1: { word: string; similarity: number }
): Promise<void> {
  const queryHash = crypto
    .createHash("sha256")
    .update(query.trim().toLowerCase())
    .digest("hex");

  // Raw SQL: GlossEmbedding's `embedding` column is Unsupported("halfvec(384)"),
  // the same reason VocabEmbedding is queried via $queryRawUnsafe rather than
  // the typed client (see app/api/lookup/route.ts, lib/wordData.ts).
  const [newHit] = await prisma.$queryRawUnsafe<
    { synsetKey: string; lemmas: string[]; similarity: number }[]
  >(
    `SELECT "synsetKey", "lemmas", 1 - (embedding <=> $1::halfvec) AS similarity
     FROM "GlossEmbedding"
     ORDER BY embedding <=> $1::halfvec
     LIMIT 1`,
    vectorLiteral
  );
  if (!newHit || newHit.lemmas.length === 0) return; // GlossEmbedding empty/unbuilt — nothing to log yet

  const newTop1 = newHit.lemmas[0];

  await prisma.shadowLookup.create({
    data: {
      queryHash,
      oldTop1: oldTop1.word,
      oldSimilarity: oldTop1.similarity,
      newTop1,
      newSimilarity: newHit.similarity,
      agree: oldTop1.word === newTop1,
    },
  });
}
