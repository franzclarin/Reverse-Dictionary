import { NextRequest, NextResponse } from "next/server";
import { embed, embedTokens } from "@/lib/embedder";
import { prisma } from "@/lib/prisma";
import {
  searchGloss,
  searchGlossSynsets,
  expandSynsets,
  GLOSS_PROBES,
  GLOSS_LISTS,
  type VizSynsetHit,
} from "@/lib/glossSearch";
import { parseVectorLiteral } from "@/lib/viz/projection";
import { runShadowLookup } from "@/lib/shadowLookup";
import { logQuery } from "@/lib/queryLog";
import {
  Subsystem,
  SubsystemError,
  describeError,
  formatErrorShape,
} from "@/lib/errors";

export const runtime = "nodejs";
// A safety ceiling, not a target. Lowering it would only turn a slow database
// query into a worse error, and we are billed for time used, not the limit.
export const maxDuration = 60;

// Occasionally run the old search too and log whether the two agree. Kept on
// because the comparison becomes worth reading if this app ever gets traffic.
// Set to false to stop logging without touching anything else.
const SHADOW_LOOKUP_ENABLED = true;
const SHADOW_SAMPLE_RATE = 0.1;

// Keep every real search alongside the words and scores it produced — see the
// QueryLog model for what this changed and why it is worth keeping.
// Set to false to stop recording without touching anything else.
const QUERY_LOG_ENABLED = true;

type ResultRow = { word: string; similarity: number };

/** Most results anyone may ask for at once, so nobody can request the whole index. */
const MAX_K = 100;

/** How many word-parts /explain gets back, before the response gets fat. */
const MAX_DEBUG_TOKENS = 64;

/** The extra working-out sent back when a request asks for it, for /explain. */
// A request has to ask; a normal search takes the same path it always has.
// This branch reuses the real search rather than repeating it — the words that
// come back are identical, it just keeps the details instead of discarding them.
type DebugPayload = {
  queryVector: number[];
  /** The numbers for each word-part, which /explain animates averaging into one. */
  tokenVectors: number[][];
  tokenVectorsTruncated: boolean;
  synsets: {
    synsetKey: string;
    gloss: string;
    lemmas: string[];
    similarity: number;
    vector: number[];
  }[];
  probes: number;
  lists: number;
};

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
    const { query, k = 10, debug = false } = body as {
      query: string;
      k?: number;
      debug?: boolean;
    };

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
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      return NextResponse.json(
        { error: `k must be an integer between 1 and ${MAX_K}` },
        { status: 400 }
      );
    }

    // Timed on its own, so a slow start is distinguishable from a fast failure.
    const embedStartedAt = Date.now();
    // The /explain branch gets the same answer in one pass, keeping the
    // per-word-part detail. Normal search uses the plain call below.
    let tokenVectors: number[][] = [];
    let embedding: number[];
    if (debug) {
      const encoded = await embedTokens(query);
      embedding = encoded.pooled;
      tokenVectors = encoded.tokenVectors;
    } else {
      embedding = await embed(query);
    }
    console.log(`[lookup] embed ok ms=${Date.now() - embedStartedAt} dims=${embedding.length}`);

    const vectorLiteral = `[${embedding.join(",")}]`;

    const dbStartedAt = Date.now();
    let rows: ResultRow[];
    let debugPayload: DebugPayload | undefined;
    try {
      // Search by meaning. The old word-by-word index is still there and still
      // filled, so switching this one call back is the whole way to undo it.
      if (debug) {
        // The same search, keeping the details instead of dropping them. The
        // setting passed here is the normal default, only spelled out because
        // the extra options come after it.
        const hits = (await searchGlossSynsets(prisma, vectorLiteral, k, GLOSS_PROBES, {
          withGloss: true,
          withVector: true,
        })) as VizSynsetHit[];
        rows = expandSynsets(hits, k);
        debugPayload = {
          queryVector: embedding,
          tokenVectors: tokenVectors
            .slice(0, MAX_DEBUG_TOKENS)
            // Rounding roughly halves the response and is far finer than the
            // page can draw.
            .map((vector) => vector.map((value) => Math.round(value * 1e4) / 1e4)),
          tokenVectorsTruncated: tokenVectors.length > MAX_DEBUG_TOKENS,
          synsets: hits.map((hit) => ({
            synsetKey: hit.synsetKey,
            gloss: hit.gloss,
            lemmas: hit.lemmas,
            similarity: hit.similarity,
            // Arrives as text; the page turns it into a position.
            vector: parseVectorLiteral(hit.vector as unknown as string),
          })),
          probes: GLOSS_PROBES,
          lists: GLOSS_LISTS,
        };
      } else {
        rows = await searchGloss(prisma, vectorLiteral, k);
      }
    } catch (error) {
      throw new SubsystemError("database", `pgvector query failed: ${describeError(error).message}`, {
        cause: error,
      });
    }
    console.log(`[lookup] db ok ms=${Date.now() - dbStartedAt} rows=${rows.length}`);

    // Never waited for, and never allowed to slow the response down.
    // /explain's requests are skipped: they are someone poking at the demo, and
    // counting them would quietly change what this log means.
    if (!debug && SHADOW_LOOKUP_ENABLED && rows.length > 0 && Math.random() < SHADOW_SAMPLE_RATE) {
      runShadowLookup(query, vectorLiteral, rows[0]).catch((error) => {
        console.error(`[lookup] shadow log failed (non-fatal): ${formatErrorShape(describeError(error))}`);
      });
    }

    // How long the work really took — never a made-up number.
    const timingMs = Date.now() - embedStartedAt;

    // Waited for, so the record is complete rather than whatever happened to
    // survive the response — but wrapped, because failing to write down a
    // search must never fail the search itself.
    // /explain's requests are skipped for the same reason the log above skips
    // them: they are someone poking at the demo, not somebody asking for a word.
    if (!debug && QUERY_LOG_ENABLED) {
      try {
        await logQuery(query, k, rows, timingMs);
      } catch (error) {
        console.error(
          `[lookup] query log failed (non-fatal): ${formatErrorShape(describeError(error))}`
        );
      }
    }

    // The extra detail is added alongside the usual answer, never in place of
    // it, so existing callers see no change.
    return NextResponse.json(
      debugPayload ? { results: rows, timingMs, debug: debugPayload } : { results: rows, timingMs }
    );
  } catch (error) {
    const subsystem: Subsystem =
      error instanceof SubsystemError ? error.subsystem : "unknown";
    const shape = describeError(error);

    console.error(`[lookup] FAILED subsystem=${subsystem} ${formatErrorShape(shape)}`);
    if (shape.stack) console.error(`[lookup] stack: ${shape.stack}`);

    // Say which part failed, so nobody is left with a bare "fetch failed".
    // The server address is held back in production, since it identifies a
    // private database. The full details are always in the logs.
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
