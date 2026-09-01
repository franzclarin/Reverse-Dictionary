import type { PrismaClient } from "@prisma/client";

// The search itself: find the dictionary entries whose meaning is closest to
// what the user typed. Entries come from two dictionaries kept in one table,
// and search treats them identically.

/** One word we found, and how well it matched. */
export type ResultRow = { word: string; similarity: number };

/** A group of words that share one meaning, and how well that meaning matched. */
export type SynsetHit = { synsetKey: string; lemmas: string[]; similarity: number };

/** The same, with the written definition included. */
export type GlossSynsetHit = SynsetHit & { gloss: string };

/** The same again, with the raw numbers included, so /explain can draw it. */
export type VizSynsetHit = GlossSynsetHit & { vector: number[] };

/** How hard the search looks before settling on an answer. */
// Re-tune this whenever GLOSS_LISTS changes; the two only make sense together.
export const GLOSS_PROBES = 100;

/** The one place the table's name is written. */
export const GLOSS_INDEX = "GlossEmbedding";

/** How many chunks the search index is split into. */
export const GLOSS_LISTS = 833;

// The database sleeps when idle and takes seconds to wake. Wait for it rather
// than failing the user's search.
const TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 20_000 };

/** Turn groups of words into a plain list of words, best first. */
// Words in a group all score the same, so their order is a deliberate choice,
// not a result. Never sort it.
export function expandSynsets(hits: SynsetHit[], k: number): ResultRow[] {
  const out: ResultRow[] = [];
  const seen = new Set<string>();

  for (const hit of hits) {
    for (const word of hit.lemmas) {
      if (seen.has(word)) continue;
      seen.add(word);
      out.push({ word, similarity: hit.similarity });
      if (out.length >= k) return out;
    }
  }
  return out;
}

/** Ask the database for the closest meanings, before they become words. */
// Takes numbers from `embed()`; never measures text itself. Doing that in two
// places would put the question and the answers on different scales.
export async function searchGlossSynsets(
  prisma: PrismaClient,
  vectorLiteral: string,
  k: number,
  /** Only the offline test harness passes this, or we stop measuring what we serve. */
  probes: number = GLOSS_PROBES,
  /** Extra columns for /explain, off by default so a normal search fetches no extra data. */
  {
    withGloss = false,
    withVector = false,
  }: { withGloss?: boolean; withVector?: boolean } = {}
): Promise<SynsetHit[]> {
  const glossColumn = withGloss ? `"gloss", ` : "";
  const vectorColumn = withVector ? `embedding::text AS vector, ` : "";

  return prisma.$transaction(async (tx) => {
    // SET LOCAL keeps this setting to just this one query.
    await tx.$executeRawUnsafe(`SET LOCAL ivfflat.probes = ${Number(probes)}`);
    return tx.$queryRawUnsafe<SynsetHit[]>(
      `SELECT "synsetKey", ${glossColumn}${vectorColumn}"lemmas", 1 - (embedding <=> $1::halfvec) AS similarity
         FROM "${GLOSS_INDEX}"
         ORDER BY embedding <=> $1::halfvec
         LIMIT $2`,
      vectorLiteral,
      k
    );
  }, TRANSACTION_OPTIONS);
}

/** The normal search: closest meanings, expanded into a list of words. */
// Asks for k meanings, not k words, so it can return fewer than k. Intentional.
export async function searchGloss(
  prisma: PrismaClient,
  vectorLiteral: string,
  k: number,
  probes: number = GLOSS_PROBES
): Promise<ResultRow[]> {
  return expandSynsets(await searchGlossSynsets(prisma, vectorLiteral, k, probes), k);
}
