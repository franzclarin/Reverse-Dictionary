import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { Word } from "@prisma/client";

/**
 * Word data is derived entirely from the fine-tuned embedding model's
 * vocabulary — no generative API is involved.
 *
 * An embedding model maps text to a vector; it has no decoder, so it cannot
 * write a definition, etymology, or example sentence. What it *can* do is
 * place a word among its semantic neighbours, which is what this module
 * exposes. Definitions only appear for words that already have a row in
 * `Word` (generated before the Claude dependency was removed) — reading those
 * is free, so they are still shown when present.
 */

export type RelatedWord = { word: string; similarity: number };

/** True when the word is one of the ~141k entries the model has a vector for. */
async function isInVocabulary(word: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ word: string }[]>(
    `SELECT word FROM "VocabEmbedding" WHERE word = $1 LIMIT 1`,
    word
  );
  return rows.length > 0;
}

/**
 * Nearest neighbours of `word` in embedding space.
 *
 * The word's vector is already stored, so this is a pure pgvector query — it
 * never loads the ONNX model. The target vector is pulled in a subquery so
 * Postgres evaluates it once (an InitPlan) and the ORDER BY can still use the
 * IVFFlat index.
 */
export const getRelatedWords = cache(async function getRelatedWords(
  wordSlug: string,
  k = 12
): Promise<RelatedWord[]> {
  const normalized = wordSlug.toLowerCase().trim();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ivfflat.probes = 10`);
    return tx.$queryRawUnsafe<RelatedWord[]>(
      `SELECT word,
              1 - (embedding <=> (SELECT embedding FROM "VocabEmbedding" WHERE word = $1)) AS similarity
       FROM "VocabEmbedding"
       WHERE word <> $1
       ORDER BY embedding <=> (SELECT embedding FROM "VocabEmbedding" WHERE word = $1)
       LIMIT $2`,
      normalized,
      k
    );
  });
});

/**
 * Wrapped in React `cache()` so the page component and generateMetadata share
 * one result per request instead of querying twice.
 */
export const getWordData = cache(async function getWordData(
  wordSlug: string
): Promise<Word | null> {
  const normalized = wordSlug.toLowerCase().trim();

  // Previously generated profiles keep their definition, etymology, examples.
  const existing = await prisma.word.findUnique({ where: { word: normalized } });
  if (existing) return existing;

  // Otherwise the word is only valid if the model actually knows it.
  if (!(await isInVocabulary(normalized))) return null;

  // Create a minimal row so the word has a stable id for SavedWord. The text
  // fields stay empty — the page renders around whatever is missing rather
  // than inventing content the model cannot produce.
  return prisma.word.upsert({
    where: { word: normalized },
    update: {},
    create: {
      word: normalized,
      partOfSpeech: "",
      pronunciation: "",
      definition: "",
      etymology: "",
      examples: [],
      synonyms: [],
      domain: "",
    },
  });
});
