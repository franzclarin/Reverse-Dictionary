import { NextRequest, NextResponse } from "next/server";
import { embed } from "@/lib/embedder";
import { prisma } from "@/lib/prisma";
import { runShadowLookup } from "@/lib/shadowLookup";
import {
  Subsystem,
  SubsystemError,
  describeError,
  formatErrorShape,
} from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 60; // model cold-start needs up to ~20s; default 10s is too short

// Enabled per RD-02: GlossEmbedding is populated (117,791 rows, RD-01) and
// this block has been reviewed for the cutover soak. Sampled and
// fire-and-forget — see the call site below and lib/shadowLookup.ts's header
// comment for what's logged and why. Flip back to false to stop logging
// without a redeploy of anything else.
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
      // SET LOCAL ivfflat.probes inside a transaction so it applies only to this query
      rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ivfflat.probes = 10`);
        return tx.$queryRawUnsafe<ResultRow[]>(
          `SELECT word, 1 - (embedding <=> $1::vector) AS similarity
           FROM "VocabEmbedding"
           ORDER BY embedding <=> $1::vector
           LIMIT $2`,
          vectorLiteral,
          k
        );
      });
    } catch (error) {
      throw new SubsystemError("database", `pgvector query failed: ${describeError(error).message}`, {
        cause: error,
      });
    }
    console.log(`[lookup] db ok ms=${Date.now() - dbStartedAt} rows=${rows.length}`);

    // Fire-and-forget: never awaited, sampled, and never allowed to affect
    // the response or its latency. See lib/shadowLookup.ts for what's logged
    // and why. SHADOW_LOOKUP_ENABLED stays false until GlossEmbedding is
    // actually populated and this has been reviewed — see the flag's comment.
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
