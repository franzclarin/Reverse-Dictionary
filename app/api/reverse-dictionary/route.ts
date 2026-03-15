import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { ReverseDictionaryRequest, ReverseDictionaryResponse } from "@/types";
import { awardDailyLookup, getOrCreateUser } from "@/lib/credits";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Rate limiters — only created when Upstash env vars are present
function getRatelimiters() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const redis = new Redis({ url, token });
  return {
    guest: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(50, "1 d"),
      prefix: "rl:guest",
    }),
    user: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(200, "1 d"),
      prefix: "rl:user",
    }),
  };
}

const ratelimiters = getRatelimiters();

const SYSTEM_PROMPT = `You are a precise reverse dictionary. When given a description or concept, return the exact word or phrase that matches.

Your task is to:
1. Analyze the description carefully
2. Identify the most accurate word or phrase
3. Provide a clear definition
4. Include usage examples when helpful
5. Suggest alternatives if applicable

Response Format:
Return ONLY a valid JSON object with this exact structure:
{
  "word": "the exact word or phrase",
  "definition": "clear, concise definition in 1-2 sentences",
  "alternatives": ["other possible words"] (optional),
  "examples": ["usage example 1", "usage example 2"] (optional, 2-3 examples)
}

Rules:
- Prioritize precision over verbosity
- If multiple words fit, provide the most common one as "word" and others as "alternatives"
- Verify that words are real dictionary entries
- For obscure words, double-check accuracy
- If no exact match exists, provide the closest alternative
- Keep examples concise and illustrative
- Do not include any text outside the JSON object
- Ensure the JSON is valid and properly formatted`;

export async function POST(request: NextRequest) {
  const { userId } = auth();

  // Rate limiting
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
    const body: ReverseDictionaryRequest = await request.json();
    const { description } = body;

    if (!description || typeof description !== "string") {
      return NextResponse.json(
        { error: "Description is required and must be a string" },
        { status: 400 }
      );
    }

    if (description.length > 500) {
      return NextResponse.json(
        { error: "Description is too long (max 500 characters)" },
        { status: 400 }
      );
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY is not set");
      return NextResponse.json(
        { error: "API configuration error" },
        { status: 500 }
      );
    }

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: description,
        },
      ],
    });

    const responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    let parsedResponse: ReverseDictionaryResponse;
    try {
      parsedResponse = JSON.parse(responseText);
    } catch {
      console.error("Failed to parse Claude response:", responseText);
      const wordMatch = responseText.match(/"word"\s*:\s*"([^"]+)"/);
      const definitionMatch = responseText.match(
        /"definition"\s*:\s*"([^"]+)"/
      );

      if (wordMatch && definitionMatch) {
        parsedResponse = {
          word: wordMatch[1],
          definition: definitionMatch[1],
        };
      } else {
        return NextResponse.json(
          { error: "Failed to parse response from AI" },
          { status: 500 }
        );
      }
    }

    if (!parsedResponse.word || !parsedResponse.definition) {
      return NextResponse.json(
        { error: "Invalid response format from AI" },
        { status: 500 }
      );
    }

    // Attach rate limit info
    if (ratelimiters) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        "127.0.0.1";
      const key = userId ?? ip;
      const limiter = userId ? ratelimiters.user : ratelimiters.guest;
      const { remaining, limit } = await limiter.getRemaining(key);
      parsedResponse.rateLimit = {
        remaining,
        limit,
        isGuest: !userId,
      };
    }

    // Award daily lookup credits for signed-in users
    if (userId) {
      try {
        await getOrCreateUser(userId);
        const awarded = await awardDailyLookup(userId);
        if (awarded > 0) {
          parsedResponse.creditsAwarded = awarded;
        }
      } catch {
        // Non-critical — don't fail the lookup over credit errors
      }
    }

    return NextResponse.json(parsedResponse);
  } catch (error) {
    console.error("Error in reverse-dictionary API:", error);

    if (error instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: "AI service error", details: error.message },
        { status: error.status || 500 }
      );
    }

    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
