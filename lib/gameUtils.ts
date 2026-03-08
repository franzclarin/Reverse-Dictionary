import { prisma } from "./prisma";
import { Word } from "@prisma/client";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export async function getRandomWords(count: number): Promise<Word[]> {
  const total = await prisma.word.count();
  if (total === 0) return [];

  const need = Math.min(count, total);
  const results: Word[] = [];
  const usedIds = new Set<string>();
  let attempts = 0;

  while (results.length < need && attempts < need * 5) {
    const skip = Math.floor(Math.random() * total);
    const [word] = await prisma.word.findMany({
      skip,
      take: 1,
      orderBy: { id: "asc" },
    });
    if (word && !usedIds.has(word.id)) {
      results.push(word);
      usedIds.add(word.id);
    }
    attempts++;
  }

  return results;
}

let gameRatelimiter: Ratelimit | null = null;

function getGameRatelimiter(): Ratelimit | null {
  if (gameRatelimiter) return gameRatelimiter;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  gameRatelimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, "1 h"),
    prefix: "rl:game",
  });
  return gameRatelimiter;
}

export async function checkGameRateLimit(
  userId: string
): Promise<{ allowed: boolean }> {
  const rl = getGameRatelimiter();
  if (!rl) return { allowed: true };
  const result = await rl.limit(userId);
  return { allowed: result.success };
}

export function validateBet(bet: unknown): number | null {
  const n = Number(bet);
  if (!Number.isInteger(n) || n < 10 || n > 500) return null;
  return n;
}
