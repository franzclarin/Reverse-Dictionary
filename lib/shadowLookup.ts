import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Shadow-log a lookup: run the *non-primary* index alongside the primary one
 * and record whether their top-1 answers agree.
 *
 * ROLES INVERTED BY THE RD-02 CUTOVER. The gloss index is now the primary
 * search path (app/api/lookup/route.ts), so the shadow query below runs against
 * the OLD lemma index, VocabEmbedding. The ShadowLookup columns deliberately
 * keep their original meaning regardless of which side is primary:
 *
 *   old* = VocabEmbedding, the bare-lemma index
 *   new* = GlossEmbedding, the synset-keyed gloss index
 *
 * so rows written before and after the cutover remain directly comparable and
 * scripts/shadow-compare.ts needs no change. Do not repurpose these columns to
 * mean "primary"/"secondary" — that would silently split the table into two
 * incompatible eras.
 *
 * Deliberately logs a hash of the query, not the query text, preserving the
 * "no query text has ever been logged" property CLAUDE.md documents as a
 * deliberate stance. Deliberately logs only each system's top-1, not full top-k
 * or the embedding — enough to measure AGREEMENT RATE, never accuracy. That
 * limit is intrinsic: production traffic carries no labelled target, so no
 * amount of extra logging would make an accuracy comparison possible. See
 * scripts/shadow-compare.ts's header comment.
 *
 * Retained after the cutover because the soak gate was retired for lack of
 * traffic, not because its question was answered — if traffic ever arrives the
 * comparison becomes worth running retroactively. RD-10 is the measurement that
 * actually replaces it.
 *
 * Called from app/api/lookup/route.ts, sampled at SHADOW_SAMPLE_RATE. The caller
 * never awaits this and always wraps it in .catch(): a failure here must never
 * affect the user-facing lookup response.
 */
export async function runShadowLookup(
  query: string,
  vectorLiteral: string,
  /** The primary path's top-1 — post-cutover, that is the gloss index. */
  newTop1: { word: string; similarity: number }
): Promise<void> {
  const queryHash = crypto
    .createHash("sha256")
    .update(query.trim().toLowerCase())
    .digest("hex");

  // Raw SQL: VocabEmbedding's `embedding` column is Unsupported("vector(384)"),
  // the same reason the gloss index is queried via $queryRawUnsafe (see
  // lib/glossSearch.ts, lib/wordData.ts).
  const [oldHit] = await prisma.$queryRawUnsafe<
    { word: string; similarity: number }[]
  >(
    `SELECT word, 1 - (embedding <=> $1::vector) AS similarity
       FROM "VocabEmbedding"
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
    vectorLiteral
  );
  if (!oldHit) return; // VocabEmbedding empty — nothing to compare against

  await prisma.shadowLookup.create({
    data: {
      queryHash,
      oldTop1: oldHit.word,
      oldSimilarity: oldHit.similarity,
      newTop1: newTop1.word,
      newSimilarity: newTop1.similarity,
      agree: oldHit.word === newTop1.word,
    },
  });
}
