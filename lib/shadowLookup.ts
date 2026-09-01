import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

/** Run the old search alongside the current one; record whether they agree. */
// Column names track the two systems, not which is live: `old*` is always the
// word-by-word index. Repurposing them makes old and new rows incomparable.
// Only a fingerprint of the question is stored, never the question itself.
// The caller samples this and never waits for it, so a failure here is harmless.
export async function runShadowLookup(
  query: string,
  vectorLiteral: string,
  /** The live search's best answer. */
  newTop1: { word: string; similarity: number }
): Promise<void> {
  const queryHash = crypto
    .createHash("sha256")
    .update(query.trim().toLowerCase())
    .digest("hex");

  // Written as raw SQL because this column type has no direct equivalent in the
  // regular database client.
  const [oldHit] = await prisma.$queryRawUnsafe<
    { word: string; similarity: number }[]
  >(
    `SELECT word, 1 - (embedding <=> $1::vector) AS similarity
       FROM "VocabEmbedding"
       ORDER BY embedding <=> $1::vector
       LIMIT 1`,
    vectorLiteral
  );
  if (!oldHit) return; // nothing on the other side to compare against

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
