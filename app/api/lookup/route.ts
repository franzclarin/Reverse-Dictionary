import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
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

// NOT YET ENABLED — GlossEmbedding has no rows yet (see MIGRATION_AUDIT.md /
// scripts/build-gloss-index.ts), so every shadow query would just return
// nothing useful right now. Flip on only after that table is populated, and
// only after this whole block has been reviewed and deployed deliberately —
// it is not live merely because it's written.
const SHADOW_LOOKUP_ENABLED = false;
const SHADOW_SAMPLE_RATE = 0.1;

type Ratelimiters = { guest: Ratelimit; user: Ratelimit };

let ratelimitersCache: Ratelimiters | null | undefined;

/**
 * Built lazily (not at module scope): a malformed UPSTASH_REDIS_REST_URL makes
 * `new Redis()` throw, and at module scope that crashes route initialisation
 * into an empty-body 500 before our try/catch can return JSON.
 */
function getRatelimiters(): Ratelimiters | null {
  if (ratelimitersCache !== undefined) return ratelimitersCache;

  // Prefer KV_* — those are written and rotated by the Vercel/Upstash
  // Marketplace integration, so they can't go stale the way a hand-copied
  // UPSTASH_REDIS_REST_URL did (it outlived its database by 166 days and
  // took down search). UPSTASH_* stays as a fallback for local/self-managed.
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    ratelimitersCache = null;
    return null;
  }

  try {
    const redis = new Redis({ url, token });
    ratelimitersCache = {
      guest: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(50, "1 d"),
        prefix: "rl:lookup:guest",
      }),
      user: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(200, "1 d"),
        prefix: "rl:lookup:user",
      }),
    };
  } catch (error) {
    console.error(
      `[lookup] rate limiter construction failed; continuing without rate limiting. ${formatErrorShape(describeError(error))}`
    );
    ratelimitersCache = null;
  }
  return ratelimitersCache;
}

type ResultRow = { word: string; similarity: number };

type LimitOutcome = { allowed: true } | { allowed: false; message: string; guest: boolean };

/**
 * @upstash/redis talks REST over `fetch`, so stale credentials or a deleted
 * database throw "fetch failed" here — long before we touch the model.
 * Rate limiting must never take down search, so we fail open.
 */
async function checkRateLimit(
  request: NextRequest,
  userId: string | null
): Promise<LimitOutcome> {
  const ratelimiters = getRatelimiters();
  if (!ratelimiters) return { allowed: true };

  try {
    if (userId) {
      const result = await ratelimiters.user.limit(userId);
      return result.success
        ? { allowed: true }
        : {
            allowed: false,
            guest: false,
            message: "Daily limit of 200 lookups reached. Try again tomorrow.",
          };
    }

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";
    const result = await ratelimiters.guest.limit(ip);
    return result.success
      ? { allowed: true }
      : {
          allowed: false,
          guest: true,
          message: "Daily limit of 50 free lookups reached. Sign in for 200 lookups/day.",
        };
  } catch (error) {
    const shape = describeError(error);
    console.error(
      `[lookup] rate limit check failed — FAILING OPEN. ${formatErrorShape(shape)}`
    );
    return { allowed: true };
  }
}

const SUBSYSTEM_MESSAGES: Record<Subsystem, string> = {
  model:
    "The embedding model could not be loaded. This is usually a temporary network problem reaching the model host — please try again in a moment.",
  ratelimit: "The rate limiter is unavailable.",
  database:
    "The word database is unreachable. Please try again in a moment.",
  unknown: "An unexpected error occurred.",
};

export async function POST(request: NextRequest) {
  try {
    // auth() stays inside the try so a Clerk failure returns JSON, not an
    // empty-body 500 that breaks the client's response.json().
    const { userId } = auth();

    const limit = await checkRateLimit(request, userId);
    if (!limit.allowed) {
      return NextResponse.json(
        limit.guest
          ? { error: limit.message, rateLimitExceeded: true }
          : { error: limit.message },
        { status: 429 }
      );
    }

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

    // Embed + db time only — excludes auth/ratelimit overhead, which isn't
    // part of "how long did the search take" from the user's perspective.
    // Real elapsed time, including any cold-start model download: no fixed
    // placeholder number gets shown in its place.
    const timingMs = Date.now() - embedStartedAt;

    return NextResponse.json({ results: rows, timingMs });
  } catch (error) {
    const subsystem: Subsystem =
      error instanceof SubsystemError ? error.subsystem : "unknown";
    const shape = describeError(error);

    console.error(`[lookup] FAILED subsystem=${subsystem} ${formatErrorShape(shape)}`);
    if (shape.stack) console.error(`[lookup] stack: ${shape.stack}`);

    // Name the subsystem and the network code so the client never again sees a
    // bare "fetch failed". The hostname can identify a private Upstash
    // database, so it is only echoed outside production (the full shape is
    // always in the server logs regardless).
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
