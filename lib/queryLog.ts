import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Record a search and everything it returned. */
// Unlike lib/shadowLookup.ts, this stores the question itself rather than a
// fingerprint of it — the QueryLog model's comment says what changed and why.
// The results array is the one handed to the client, so the log and the answer
// cannot disagree. The caller wraps this, so a failure here never fails a search.
//
// Keyed on the search intent rather than the request: the browser can send the
// same search twice (a retry, or React re-running the effect), and the second
// arrival must not become a second row. createMany with skipDuplicates is
// ON CONFLICT DO NOTHING, which states that a duplicate is expected and fine —
// catching a unique-violation instead would send a routine event down the
// caller's error path.
export async function logQuery(
  searchId: string,
  query: string,
  k: number,
  results: { word: string; similarity: number }[],
  timingMs: number
): Promise<void> {
  await prisma.queryLog.createMany({
    data: [
      {
        searchId,
        query,
        k,
        results: results as unknown as Prisma.InputJsonValue,
        resultCount: results.length,
        timingMs,
      },
    ],
    skipDuplicates: true,
  });
}
