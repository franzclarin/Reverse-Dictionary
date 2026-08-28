import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { GLOSS_INDEX, expandSynsets, type SynsetHit } from "@/lib/glossSearch";
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
 *
 * TWO TABLES, AND WHICH ONE IS AUTHORITATIVE (RD-17).
 *
 * `VocabEmbedding` holds one vector per bare lemma and is what every function
 * here used to read. It is also the RD-02 cutover's ROLLBACK path: search has
 * answered out of the synset-keyed `GlossEmbedding` since that cutover, and the
 * two tables' lemma sets are not the same. **8,005** words were answerable by
 * search and absent from `VocabEmbedding` when this was found, and RD-17's
 * vocabulary expansion took that to **379,633** — so search returned them and
 * their page 404'd, `capsize` and `loiter` among them. Whatever search can
 * return, this module must be able to render.
 *
 * So `GlossEmbedding` is authoritative for EXISTENCE, and `VocabEmbedding`
 * stays the primary source for NEIGHBOURS. Splitting it that way is deliberate:
 * the lemma index is what a nearest-neighbour-of-a-word query is actually good
 * at, and every page that works today keeps the exact behaviour it has, with
 * the gloss path reached only by words that would otherwise have no page at all.
 */

export type RelatedWord = { word: string; similarity: number };

/**
 * True when search could return this word — i.e. it is a lemma of some synset
 * in the index `/api/lookup` actually queries.
 *
 * Backed by `GlossEmbedding_lemmas_gin_idx` (migration
 * `20260828000000_gloss_lemma_lookup`). Without that GIN index this is a
 * sequential scan over 117,791 rows on every word-page render.
 */
async function isAnswerable(word: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ synsetKey: string }[]>(
    `SELECT "synsetKey" FROM "${GLOSS_INDEX}" WHERE $1 = ANY("lemmas") LIMIT 1`,
    word
  );
  return rows.length > 0;
}

/** True when the word has a stored bare-lemma vector — the fast neighbour path. */
async function hasLemmaVector(word: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ word: string }[]>(
    `SELECT word FROM "VocabEmbedding" WHERE word = $1 LIMIT 1`,
    word
  );
  return rows.length > 0;
}

/**
 * Nearest neighbours by bare-lemma vector — the original path, unchanged.
 *
 * The word's vector is already stored, so this is a pure pgvector query — it
 * never loads the ONNX model. The target vector is pulled in a subquery so
 * Postgres evaluates it once (an InitPlan) and the ORDER BY can still use the
 * IVFFlat index.
 */
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

/**
 * Nearest neighbours by SENSE, for words with no bare-lemma vector.
 *
 * Takes the word's first synset, retrieves the nearest synsets to that synset's
 * stored vector, and expands them into member words with the same
 * `expandSynsets()` the search path uses — so the neighbour list a reader sees
 * is built by the same rule as a result list, not a second lookalike.
 *
 * Two properties worth stating because they are easy to misread as bugs:
 *
 *   - It is a SENSE's neighbourhood, not a word's. A polysemous word has
 *     several, and this shows the first, which is WordNet's most familiar sense.
 *     Averaging them would represent none of them, which is half the reason the
 *     index is keyed by synset at all.
 *   - The word itself is excluded, but its synonyms are NOT: the query synset is
 *     its own nearest neighbour at similarity 1.0, so `botch` legitimately leads
 *     `bungle`'s list. That is the correct answer to "what is this word near?".
 */
async function relatedByGloss(word: string, k: number): Promise<RelatedWord[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ivfflat.probes = 10`);
    // MATERIALIZED, and it is worth 0.9s. Spelled inline twice the way
    // `relatedByLemma` spells its subquery, Postgres re-plans the GIN lookup for
    // both the SELECT and the ORDER BY instead of folding them into one
    // InitPlan: measured 1533ms against 719ms on the same word. The lemma path
    // above does not need this because its subquery hits a unique btree.
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
      // Over-fetch: a synset yields at least one word but the query's own synset
      // contributes only its synonyms, and dedupe drops the word itself.
      k + 4
    );
    return expandSynsets(hits, k + 1)
      .filter((r) => r.word.toLowerCase() !== word)
      .slice(0, k);
  });
}

/**
 * Nearest neighbours of `word` in embedding space.
 *
 * THE EXISTENCE CHECK IS NOT OPTIONAL, and skipping it was a live bug — a
 * pre-existing one, since the single-table version had the same hole. 47 of the
 * 475 rows in `Word` are words profiled in the Claude era that have no vector in
 * either table (`petrichor` is one: it has a real definition and is in no
 * index). `getWordData` returns those rows, so the page renders, and the
 * neighbour query then runs `embedding <=> (SELECT ... WHERE word = $1)` against
 * a subquery matching nothing. That is not an error in Postgres: the subquery is
 * NULL, every distance is NULL, and the ORDER BY ranks nothing — so the page
 * came back with twelve arbitrary rows presented as semantic neighbours.
 *
 * A word with no vector has no neighbours, and saying so is the honest answer.
 * The page already renders around missing data.
 *
 * Wrapped in React `cache()` so the page component and generateMetadata share
 * one result per request instead of querying twice.
 */
export const getRelatedWords = cache(async function getRelatedWords(
  wordSlug: string,
  k = 12
): Promise<RelatedWord[]> {
  const normalized = wordSlug.toLowerCase().trim();
  if (await hasLemmaVector(normalized)) return relatedByLemma(normalized, k);
  if (await isAnswerable(normalized)) return relatedByGloss(normalized, k);
  return [];
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

  // Otherwise the word is only valid if SEARCH could have produced it. Asking
  // `VocabEmbedding` here was the bug: it is the rollback path, and it 404'd
  // 8,005 words the live index can return.
  if (!(await isAnswerable(normalized))) return null;

  // Create a minimal row so the word has a stable id and URL. The text fields
  // stay empty — the page renders around whatever is missing rather than
  // inventing content the model cannot produce.
  //
  // GOTCHA, unchanged and still load-bearing: these rows are indistinguishable
  // from a real profile by presence alone. If a generative source is ever added
  // back, regenerate on `definition === ""`, not on row-absence, or every word
  // visited during this era stays blank forever.
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
