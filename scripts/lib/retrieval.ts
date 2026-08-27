/**
 * The production retrieval path, mirrored for offline evaluation.
 *
 * This is a deliberate mirror of `app/api/lookup/route.ts` — the same
 * `$transaction`, the same `SET LOCAL ivfflat.probes`, the same `<=>` ordering
 * and `1 - distance` similarity. It must not drift. The embedding side is not
 * mirrored at all: we import `embed` from `lib/embedder.ts` directly, because a
 * second embedding path would make every number here fiction.
 *
 * Additions over the route (all opt-in, all off by default):
 *   - `exact`      : disable index scans for a true nearest-neighbour ceiling
 *   - `filterJunk` : restrict the candidate pool to plausibly-answerable lemmas
 *
 * Since the RD-02 cutover the route searches the synset-keyed gloss index, so
 * `index: GLOSS_INDEX` is the setting that mirrors production. That path is not
 * reimplemented here — it DELEGATES to the same `lib/glossSearch.ts` the route
 * calls, because the whole point of this file is that there is one retrieval
 * path, not two that resemble each other. The lemma queries below remain for
 * the rollback path and for lemma-vs-gloss comparisons.
 */
import type { PrismaClient } from "@prisma/client";
import { GLOSS_INDEX, searchGloss } from "../../lib/glossSearch";

export type ResultRow = { word: string; similarity: number };

export const PRODUCTION_PROBES = 10;

/**
 * True for a `VocabEmbedding` row that cannot be the answer to a
 * reverse-dictionary query, and so only crowds the neighbourhood around rows
 * that can.
 *
 * Written as one SQL expression so the same text backs both the proposed
 * `answerable_vocab` view and the inline `--filter-junk` WHERE clause. `%s` is
 * the table alias.
 *
 * Deliberately NOT included: multi-word entries. "deja vu", "stiff upper lip"
 * and "red herring" are legitimate answers, and the audit found the multi-word
 * class is far too mixed to reject wholesale.
 */
export function junkPredicate(alias = ""): string {
  const w = alias ? `${alias}.word` : "word";
  return [
    `${w} ~ '^[A-Z]'`, // proper nouns: Peary, Damascene, Crane
    `${w} ~ '[0-9]'`, // A-bomb variants, 3-D, chapter numbers
    `${w} ~ '[^A-Za-z0-9 _''-]'`, // slashes, periods, parens, diacritic-free junk
  ].join("\n         OR ");
}

export const DEFAULT_INDEX = "VocabEmbedding";

/** Table names are interpolated, never parameterised — whitelist the shape. */
export function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

export type SearchOptions = {
  k?: number;
  probes?: number;
  /** Force a sequential scan — the true nearest-neighbour ceiling. */
  exact?: boolean;
  /** Restrict the candidate pool with `junkPredicate()`. */
  filterJunk?: boolean;
  /** Table to search. Must expose `word` and `embedding`. */
  index?: string;
  /**
   * The table holds one row per (word, sense) rather than one per word. Take
   * the best-matching sense per word, then dedupe by word — a single averaged
   * vector represents no sense of a polysemous word well, which is half the
   * point of a gloss index.
   */
  perSense?: boolean;
  /**
   * Candidates to pull before per-sense dedupe. One word can occupy many
   * senses, so k rows of raw nearest-neighbours may collapse to far fewer
   * distinct words. Ignored when `exact` is set (that path groups the whole
   * table and needs no over-fetch).
   */
  overfetch?: number;
};

/**
 * Run the pgvector search exactly as `/api/lookup` does.
 *
 * `embedding` must already be the 384-dim L2-normalised vector from
 * `embed()` — this function never embeds, so callers cannot accidentally
 * introduce a second encoder.
 */
export async function search(
  prisma: PrismaClient,
  embedding: number[],
  options: SearchOptions = {}
): Promise<ResultRow[]> {
  const {
    k = 10,
    // Left undefined so each index applies its OWN default: the lemma path
    // below uses PRODUCTION_PROBES (10), the gloss path uses GLOSS_PROBES (40).
    // Defaulting here would silently impose the lemma tuning on the gloss
    // index, which is exactly the mistake that cost 5.5 points before it was
    // measured. An explicit --probes still overrides both.
    probes,
    exact = false,
    filterJunk = false,
    index = DEFAULT_INDEX,
    perSense = false,
    overfetch = 12,
  } = options;

  const table = assertSafeIdentifier(index);
  const vectorLiteral = `[${embedding.join(",")}]`;
  const where = filterJunk ? `WHERE NOT (${junkPredicate()})` : "";

  if (table === GLOSS_INDEX) {
    // The gloss table is keyed by synset and has no `word` column, so none of
    // the lemma-shaped options below apply to it. Refuse rather than silently
    // ignore them: a run tagged `--filter-junk` that quietly did no filtering
    // would put a false claim in eval/runs/*.json.
    const unsupported = [
      exact && "--exact",
      filterJunk && "--filter-junk",
      perSense && "--per-sense",
    ].filter(Boolean);
    if (unsupported.length > 0) {
      throw new Error(
        `${unsupported.join(", ")} cannot apply to ${GLOSS_INDEX}: it is keyed by synset, ` +
          `not by word. Synset expansion already collapses senses, and the junk predicate ` +
          `is a lemma-surface test with nothing to match against.`
      );
    }
    return searchGloss(prisma, vectorLiteral, k, probes);
  }

  return prisma.$transaction(async (tx) => {
    if (exact) {
      // A sequential scan over 141,854 x 384 floats is cheap, and it is the
      // only way to see what the approximate index is losing.
      await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan = off`);
      await tx.$executeRawUnsafe(`SET LOCAL enable_bitmapscan = off`);
    } else {
      await tx.$executeRawUnsafe(
        `SET LOCAL ivfflat.probes = ${Number(probes ?? PRODUCTION_PROBES)}`
      );
    }

    if (!perSense) {
      // The production query, unchanged.
      return tx.$queryRawUnsafe<ResultRow[]>(
        `SELECT word, 1 - (embedding <=> $1::vector) AS similarity
           FROM "${table}"
           ${where}
           ORDER BY embedding <=> $1::vector
           LIMIT $2`,
        vectorLiteral,
        k
      );
    }

    if (exact) {
      // True max-similarity per word over the whole table. Only affordable
      // because the 2x2 runs on a local file-backed pool.
      return tx.$queryRawUnsafe<ResultRow[]>(
        `SELECT word, max(1 - (embedding <=> $1::vector)) AS similarity
           FROM "${table}"
           ${where}
           GROUP BY word
           ORDER BY similarity DESC
           LIMIT $2`,
        vectorLiteral,
        k
      );
    }

    // Index-friendly path: pull k * overfetch nearest senses, then collapse to
    // one row per word keeping its best sense.
    return tx.$queryRawUnsafe<ResultRow[]>(
      `SELECT word, max(similarity) AS similarity
         FROM (
           SELECT word, 1 - (embedding <=> $1::vector) AS similarity
             FROM "${table}"
             ${where}
             ORDER BY embedding <=> $1::vector
             LIMIT $3
         ) candidates
        GROUP BY word
        ORDER BY similarity DESC
        LIMIT $2`,
      vectorLiteral,
      k,
      k * overfetch
    );
  });
}
