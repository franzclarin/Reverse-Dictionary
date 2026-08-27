import { NextRequest, NextResponse } from "next/server";
import { embed } from "@/lib/embedder";
import { prisma } from "@/lib/prisma";
import { searchGloss } from "@/lib/glossSearch";
import { runShadowLookup } from "@/lib/shadowLookup";
import {
  Subsystem,
  SubsystemError,
  describeError,
  formatErrorShape,
} from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60; // model cold-start needs up to ~20s; default 10s is too short

// Shadow logging survives the RD-02 cutover with its roles INVERTED: the gloss
// index is now the primary path, so the sampled shadow query runs against the
// old lemma index (VocabEmbedding) instead. The ShadowLookup columns keep their
// original meaning — `old*` is always the lemma index and `new*` always the
// gloss index — so rows logged before and after the cutover stay comparable and
// scripts/shadow-compare.ts needs no change.
//
// Kept on rather than removed because the soak gate was retired for lack of
// traffic, not because the question was answered: if this app ever does get
// traffic, the comparison becomes worth running retroactively. Sampled and
// fire-and-forget; flip to false to stop logging without touching anything else.
const SHADOW_LOOKUP_ENABLED = true;
const SHADOW_SAMPLE_RATE = 0.1;

type ResultRow = { word: string; similarity: number };

const SUBSYSTEM_MESSAGES: Record<Subsystem, string> = {
  model:
    "The embedding model could not be loaded. This is usually a temporary network problem reaching the model host — please try again in a moment.",
  database:
    "The word database is unreachable. Please try again in a moment.",
  unknown: "An unexpected error occurred.",
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query, k = 10 } = body as { query: string; k?: number };

    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "query is required and must be a string" },
        { status: 400 }
      );
    }
    if (query.length > 500) {
      return NextResponse.json(
        { error: "query too long (max 500 characters)" },
        { status: 400 }
      );
    }

    // Timed separately so a cold-start model download (seconds) is
    // distinguishable from an instant failure in the logs.
    const embedStartedAt = Date.now();
    const embedding = await embed(query);
    console.log(`[lookup] embed ok ms=${Date.now() - embedStartedAt} dims=${embedding.length}`);

    const vectorLiteral = `[${embedding.join(",")}]`;

    const dbStartedAt = Date.now();
    let rows: ResultRow[];
    try {
      // RD-02 cutover: search the synset-keyed gloss index rather than the bare
      // lemma index. Expansion semantics live in lib/glossSearch.ts and mirror
      // the eval cell this decision was made on — see that file's header before
      // changing anything about how synsets become words.
      //
      // VocabEmbedding is deliberately left populated and indexed as the
      // rollback path: reverting this call is the whole rollback, no data
      // migration involved.
      rows = await searchGloss(prisma, vectorLiteral, k);
    } catch (error) {
      throw new SubsystemError("database", `pgvector query failed: ${describeError(error).message}`, {
        cause: error,
      });
    }
    console.log(`[lookup] db ok ms=${Date.now() - dbStartedAt} rows=${rows.length}`);

    // Fire-and-forget: never awaited, sampled, and never allowed to affect the
    // response or its latency. rows[0] is now the GLOSS index's top-1 (the new
    // primary); runShadowLookup queries the old lemma index itself. See
    // lib/shadowLookup.ts for what's logged and why.
    if (SHADOW_LOOKUP_ENABLED && rows.length > 0 && Math.random() < SHADOW_SAMPLE_RATE) {
      runShadowLookup(query, vectorLiteral, rows[0]).catch((error) => {
        console.error(`[lookup] shadow log failed (non-fatal): ${formatErrorShape(describeError(error))}`);
      });
    }

    // Embed + db time only. Real elapsed time, including any cold-start
    // model download: no fixed placeholder number gets shown in its place.
    const timingMs = Date.now() - embedStartedAt;

    return NextResponse.json({ results: rows, timingMs });
  } catch (error) {
    const subsystem: Subsystem =
      error instanceof SubsystemError ? error.subsystem : "unknown";
    const shape = describeError(error);

    console.error(`[lookup] FAILED subsystem=${subsystem} ${formatErrorShape(shape)}`);
    if (shape.stack) console.error(`[lookup] stack: ${shape.stack}`);

    // Name the subsystem and the network code so the client never again sees a
    // bare "fetch failed". The hostname can identify a private database, so
    // it is only echoed outside production (the full shape is always in the
    // server logs regardless).
    const detailParts = [
      `${subsystem}: ${shape.message}`,
      shape.code ? `code=${shape.code}` : undefined,
      shape.hostname && process.env.NODE_ENV !== "production"
        ? `host=${shape.hostname}`
        : undefined,
    ].filter(Boolean);

    return NextResponse.json(
      {
        error: SUBSYSTEM_MESSAGES[subsystem],
        subsystem,
        code: shape.code,
        detail: detailParts.join(" "),
      },
      { status: 500 }
    );
  }
}
