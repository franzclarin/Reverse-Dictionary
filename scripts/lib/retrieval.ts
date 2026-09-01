// The real search, copied here so it can be scored offline. It must not drift
// from the live version, so the meaning-based path calls the very same code the
// app calls rather than repeating it, and measuring text is never redone here —
// a second way of doing that would make every number below fiction.
//
// Two extras the app doesn't have, both off unless asked for: search everything
// exhaustively, and ignore words that could never be an answer.
import type { PrismaClient } from "@prisma/client";
import { GLOSS_INDEX, searchGloss } from "../../lib/glossSearch";

export type ResultRow = { word: string; similarity: number };

export const PRODUCTION_PROBES = 10;

/** Spots entries that could never be the answer, and only crowd the ones that could. */
// Written once, in one place, so everything that filters uses the same rule.
// Multi-word entries are deliberately kept: "deja vu" is a legitimate answer.
export function junkPredicate(alias = ""): string {
  const w = alias ? `${alias}.word` : "word";
  return [
    `${w} ~ '^[A-Z]'`, // proper nouns: Peary, Damascene, Crane
    `${w} ~ '[0-9]'`, // A-bomb variants, 3-D, chapter numbers
    `${w} ~ '[^A-Za-z0-9 _''-]'`, // slashes, periods, parens, diacritic-free junk
  ].join("\n         OR ");
}

export const DEFAULT_INDEX = "VocabEmbedding";

/** Table names get pasted into the query, so only allow safe-looking ones. */
export function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

export type SearchOptions = {
  k?: number;
  probes?: number;
  /** Check every row. Slow, but shows the best score possible. */
  exact?: boolean;
  /** Leave out entries that could never be an answer. */
  filterJunk?: boolean;
  /** Which table to search. */
  index?: string;
  /** The table stores each meaning separately, so keep each word's best one. */
  perSense?: boolean;
  /** Ask for extra rows first, since one word can appear under many meanings. */
  overfetch?: number;
};

/** Run the search exactly as the live app does. */
// Takes numbers already measured by `embed()`; never measures text itself, so
// no caller can accidentally slip in a second way of doing it.
export async function search(
  prisma: PrismaClient,
  embedding: number[],
  options: SearchOptions = {}
): Promise<ResultRow[]> {
  const {
    k = 10,
    // Left unset so each index uses its own setting. Choosing one here would
    // silently force one index's tuning onto the other, which has cost real
    // accuracy before. Passing --probes still overrides both.
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
    // These options don't apply to the meaning-based table. Refuse rather than
    // ignore them, or a saved result would claim a filter that never ran.
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
      // Checking every row is cheap here, and it is the only way to see what
      // the fast-but-approximate index is missing.
      await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan = off`);
      await tx.$executeRawUnsafe(`SET LOCAL enable_bitmapscan = off`);
    } else {
      await tx.$executeRawUnsafe(
        `SET LOCAL ivfflat.probes = ${Number(probes ?? PRODUCTION_PROBES)}`
      );
    }

    if (!perSense) {
      // The live query, unchanged.
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
      // Each word's genuine best score across the whole table. Only affordable
      // because this runs against a local file.
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

    // Pull extra nearby meanings, then keep one row per word — its best one.
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
