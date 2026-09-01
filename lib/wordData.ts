import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { GLOSS_INDEX, expandSynsets, type SynsetHit } from "@/lib/glossSearch";
import { Word } from "@prisma/client";

// Everything a word's page shows. The model can only measure how close two
// meanings are, not write, so definitions here are only ever stored ones.
//
// Two tables, two jobs: the search index decides whether a word exists at all,
// because anything search returns needs a page; the older word-by-word table
// finds similar words, which is what it is good at.

export type RelatedWord = { word: string; similarity: number };

/** True when search could return this word, so it needs a page. */
async function isAnswerable(word: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ synsetKey: string }[]>(
    `SELECT "synsetKey" FROM "${GLOSS_INDEX}" WHERE $1 = ANY("lemmas") LIMIT 1`,
    word
  );
  return rows.length > 0;
}

/** True when we already have this word measured on its own, the fast path. */
async function hasLemmaVector(word: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ word: string }[]>(
    `SELECT word FROM "VocabEmbedding" WHERE word = $1 LIMIT 1`,
    word
  );
  return rows.length > 0;
}

/** Similar words, straight from the word-by-word table. */
// The word is already measured, so this never has to load the model.
async function relatedByLemma(word: string, k: number): Promise<RelatedWord[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ivfflat.probes = 10`);
    return tx.$queryRawUnsafe<RelatedWord[]>(
      `SELECT word,
              1 - (embedding <=> (SELECT embedding FROM "VocabEmbedding" WHERE word = $1)) AS similarity
       FROM "VocabEmbedding"
       WHERE word <> $1
       ORDER BY embedding <=> (SELECT embedding FROM "VocabEmbedding" WHERE word = $1)
       LIMIT $2`,
      word,
      k
    );
  });
}

/** Similar words for a word we have no individual measurement for. */
// Uses the word's most familiar meaning. The word itself is dropped from the
// results; its synonyms are not, since they really are its nearest neighbours.
async function relatedByGloss(word: string, k: number): Promise<RelatedWord[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ivfflat.probes = 10`);
    // MATERIALIZED forces the lookup to happen once instead of twice, which
    // halves how long this takes.
    const hits = await tx.$queryRawUnsafe<SynsetHit[]>(
      `WITH q AS MATERIALIZED (
         SELECT embedding FROM "${GLOSS_INDEX}"
          WHERE $1 = ANY("lemmas") ORDER BY id LIMIT 1
       )
       SELECT "synsetKey", "lemmas",
              1 - (embedding <=> (SELECT embedding FROM q)) AS similarity
         FROM "${GLOSS_INDEX}"
        ORDER BY embedding <=> (SELECT embedding FROM q)
        LIMIT $2`,
      word,
      // Ask for a few extra, since the word itself gets dropped from the list.
      k + 4
    );
    return expandSynsets(hits, k + 1)
      .filter((r) => r.word.toLowerCase() !== word)
      .slice(0, k);
  });
}

/** Words closest in meaning to this one. */
// Check we have the word measured first. Comparing against nothing is not an
// error here — it just returns twelve unrelated words that look convincing.
export const getRelatedWords = cache(async function getRelatedWords(
  wordSlug: string,
  k = 12
): Promise<RelatedWord[]> {
  const normalized = wordSlug.toLowerCase().trim();
  if (await hasLemmaVector(normalized)) return relatedByLemma(normalized, k);
  if (await isAnswerable(normalized)) return relatedByGloss(normalized, k);
  return [];
});

/** The stored record for a word, creating a blank one if it is new to us. */
export const getWordData = cache(async function getWordData(
  wordSlug: string
): Promise<Word | null> {
  const normalized = wordSlug.toLowerCase().trim();

  // Words written up earlier keep their definition, etymology and examples.
  const existing = await prisma.word.findUnique({ where: { word: normalized } });
  if (existing) return existing;

  // Otherwise the word only gets a page if search could have produced it.
  if (!(await isAnswerable(normalized))) return null;

  // A blank record, so the word has a stable URL. The page copes with the gaps.
  // Careful: a blank looks exactly like a real write-up. If definitions ever
  // come back, refill on "definition is empty", not on "record is missing".
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
