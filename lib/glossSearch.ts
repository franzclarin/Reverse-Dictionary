import type { PrismaClient } from "@prisma/client";

/**
 * Synset-keyed gloss retrieval — the production search path as of RD-02.
 *
 * This is a deliberate mirror of `searchLocalSynsets()` in
 * `scripts/lib/localIndex.ts`, which is what produced the `cell_gloss_ft_synset`
 * numbers the cutover was decided on (25.8% lenient R@1, echo 14.4%). The
 * expansion semantics below must not drift from it: take the top-k *synsets*,
 * expand each into its member words in WordNet's own within-synset order,
 * dedupe by word across synsets, and stop at k words. Any change here silently
 * invalidates that measurement.
 *
 * Two differences from the eval cell, both understood and neither a drift:
 *
 *   1. The cell is a brute-force scan over a local file and is therefore EXACT.
 *      This path uses `GlossEmbedding`'s IVFFlat index, so it is approximate.
 *      The equivalent cost measured on `VocabEmbedding` was ~0.3 points of
 *      lenient R@1 (p = 1.0) — small, and the same trade production already made.
 *   2. Expansion order is read from the stored `lemmas` array rather than
 *      recomputed from WordNet at query time. `scripts/build-gloss-index.ts`
 *      writes `lemmas` as `sense.words`, which IS WordNet's order, so the two
 *      agree by construction. **Never sort this array** — alphabetical ordering
 *      measured 2.5 points worse on identical vectors.
 */

export type ResultRow = { word: string; similarity: number };

/**
 * One retrieved synset, before `expandSynsets()` collapses it into words.
 *
 * Exported since RD-12: a cross-encoder scores `(query, gloss)`, so the rerank
 * stage has to see the synset — its gloss text and its stored `lemmas` order —
 * before anything truncates the list to k words.
 */
export type SynsetHit = { synsetKey: string; lemmas: string[]; similarity: number };

/** A `SynsetHit` fetched with `{ withGloss: true }`. */
export type GlossSynsetHit = SynsetHit & { gloss: string };

/**
 * IVFFlat probes for the gloss index. **Not 10** — the lemma index's value does
 * not transfer, and assuming it did cost 5.5 points of lenient R@1.
 *
 * Measured on the frozen set (authored reachable slice, n=287, RD-02 cutover):
 *
 *   probes=10    lenient R@1 18.5%   R@10 39.4%   db p50 458ms
 *   probes=40    lenient R@1 24.0%   R@10 49.8%   db p50 479ms
 *   probes=100   lenient R@1 25.4%   R@10 51.6%   db p50 616ms
 *   (exact ceiling, brute force: ~25.8% / ~51.2%)
 *
 * 40 is the knee: it recovers almost all of the approximation loss for ~20ms,
 * while 100 buys 1.4 further points for ~137ms. Those p50s are local-to-Neon
 * round trips (~450ms of each is network), so the *scan* cost is roughly
 * 8/29/166ms — which is the number that matters in production, where both
 * sides sit in iad1.
 *
 * Why the lemma index tolerates probes=10 and this one does not: `lists = 115`
 * over 117,791 synset rows means each probe covers ~1,000 rows, and gloss
 * vectors cluster far less cleanly than bare lemmas, so the correct answer
 * frequently sits outside the 10 nearest lists. Re-tune this if the index is
 * ever rebuilt with a different `lists`.
 */
export const GLOSS_PROBES = 40;

/** The one place the gloss table's name is written. */
export const GLOSS_INDEX = "GlossEmbedding";

/**
 * Expand ranked synsets into ranked words.
 *
 * Each word inherits its synset's similarity, because synset mates carry
 * bit-identical vectors — retrieval genuinely cannot separate `bungle` from
 * `botch`, so their order is a *policy* (sense familiarity), not a result.
 *
 * NOTE THE SCORING SURFACE: one synset can occupy several result slots, so a
 * large synset at rank 1 can fill the whole list by itself. That is the
 * measured behaviour of the variant that was chosen, not a bug to correct.
 */
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

/**
 * Fetch the top-k *synsets* for a query vector — the raw retrieval result,
 * before expansion into words.
 *
 * `vectorLiteral` must already be the 384-dim L2-normalised vector from
 * `embed()`, formatted as a `[..]` literal. This function never embeds — a
 * second encoder would put query vectors in a different space than the stored
 * ones.
 *
 * Split out of `searchGloss()` for RD-12 so the eval harness's rerank stage can
 * see synsets before they are collapsed, rather than reimplementing this query
 * under `scripts/`. There is one gloss retrieval path, not two that resemble
 * each other; `searchGloss()` below is now a thin composition over this.
 */
export async function searchGlossSynsets(
  prisma: PrismaClient,
  vectorLiteral: string,
  k: number,
  /**
   * Defaults to GLOSS_PROBES. Exposed only so the eval harness can sweep it —
   * the route must never pass a value here, or the thing being measured stops
   * being the thing being served.
   */
  probes: number = GLOSS_PROBES,
  /**
   * Also select the `gloss` column. **Off by default on purpose**: with it off
   * this emits byte-identical SQL to the pre-RD-12 query, so the serving path
   * pulls not one extra byte over the wire. Only a caller that actually reads
   * gloss text — the cross-encoder — should turn it on.
   */
  { withGloss = false }: { withGloss?: boolean } = {}
): Promise<SynsetHit[]> {
  const glossColumn = withGloss ? `"gloss", ` : "";

  return prisma.$transaction(async (tx) => {
    // SET LOCAL inside a transaction so it applies only to this query.
    await tx.$executeRawUnsafe(`SET LOCAL ivfflat.probes = ${Number(probes)}`);
    return tx.$queryRawUnsafe<SynsetHit[]>(
      `SELECT "synsetKey", ${glossColumn}"lemmas", 1 - (embedding <=> $1::halfvec) AS similarity
         FROM "${GLOSS_INDEX}"
         ORDER BY embedding <=> $1::halfvec
         LIMIT $2`,
      vectorLiteral,
      k
    );
  });
}

/**
 * Run the gloss-index search exactly as the eval cell did.
 *
 * Fetches k synsets, not k rows: every synset yields at least one word, so k
 * synsets normally yield at least k words. Where several top synsets share
 * their entire membership the result can come back short, which is what the
 * eval measured too — deliberately not padded by over-fetching, since that
 * would append words the measured variant never returned.
 */
export async function searchGloss(
  prisma: PrismaClient,
  vectorLiteral: string,
  k: number,
  probes: number = GLOSS_PROBES
): Promise<ResultRow[]> {
  return expandSynsets(await searchGlossSynsets(prisma, vectorLiteral, k, probes), k);
}
