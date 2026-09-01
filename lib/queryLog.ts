import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Record a search and everything it returned. */
// Unlike lib/shadowLookup.ts, this stores the question itself rather than a
// fingerprint of it — the QueryLog model's comment says what changed and why.
// The results array is the one handed to the client, so the log and the answer
// cannot disagree. The caller wraps this, so a failure here never fails a search.
export async function logQuery(
  query: string,
  k: number,
  results: { word: string; similarity: number }[],
  timingMs: number
): Promise<void> {
  await prisma.queryLog.create({
    data: {
      query,
      k,
      results: results as unknown as Prisma.InputJsonValue,
      resultCount: results.length,
      timingMs,
    },
  });
}
