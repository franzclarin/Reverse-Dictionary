import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { embed } from "@/lib/embedder";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function getRatelimiters() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const redis = new Redis({ url, token });
  return {
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
}

const ratelimiters = getRatelimiters();

type ResultRow = { word: string; similarity: number };

export async function POST(request: NextRequest) {
  const { userId } = auth();

  if (ratelimiters) {
    if (userId) {
      const result = await ratelimiters.user.limit(userId);
      if (!result.success) {
        return NextResponse.json(
          { error: "Daily limit of 200 lookups reached. Try again tomorrow." },
          { status: 429 }
        );
      }
    } else {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        "127.0.0.1";
      const result = await ratelimiters.guest.limit(ip);
      if (!result.success) {
        return NextResponse.json(
          {
            error:
              "Daily limit of 50 free lookups reached. Sign in for 200 lookups/day.",
            rateLimitExceeded: true,
          },
          { status: 429 }
        );
      }
    }
  }

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

    const embedding = await embed(query);
    const vectorLiteral = `[${embedding.join(",")}]`;

    // SET LOCAL ivfflat.probes inside a transaction so it applies only to this query
    const rows = await prisma.$transaction(async (tx) => {
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

    return NextResponse.json({ results: rows });
  } catch (error) {
    console.error("Error in /api/lookup:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
