import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import Anthropic from "@anthropic-ai/sdk";
import { signToken, verifyToken } from "@/lib/gameTokens";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { getRandomWords, checkGameRateLimit, validateBet } from "@/lib/gameUtils";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type RouletteToken = {
  word: string;
  bet: number;
  guessesLeft: number;
  userId: string;
  exp: number;
};

export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { allowed } = await checkGameRateLimit(userId);
  if (!allowed)
    return NextResponse.json(
      { error: "Rate limit: max 60 rounds/hour." },
      { status: 429 }
    );

  const body = await req.json();
  const action: string = body.action;

  // ── START ──────────────────────────────────────────────────────────────────
  if (action === "start") {
    const bet = validateBet(body.bet);
    if (!bet)
      return NextResponse.json(
        { error: "Bet must be 10–500 credits." },
        { status: 400 }
      );

    const user = await getOrCreateUser(userId);
    if (user.credits < bet)
      return NextResponse.json(
        { error: "Insufficient credits." },
        { status: 400 }
      );

    const words = await getRandomWords(1);
    if (!words.length)
      return NextResponse.json(
        { error: "No words in database yet. Use the reverse dictionary first!" },
        { status: 400 }
      );

    const word = words[0];
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 256,
      temperature: 0.7,
      messages: [
        {
          role: "user",
          content: `Given the word "${word.word}", write a single evocative, poetic clue that hints at its meaning without using the word itself or obvious synonyms. The clue should be challenging but fair. Return only the clue, no preamble.`,
        },
      ],
    });

    const clue =
      msg.content[0].type === "text" ? msg.content[0].text.trim() : word.definition;

    const token = signToken({ word: word.word, bet, guessesLeft: 3, userId });
    return NextResponse.json({ clue, token });
  }

  // ── GUESS ──────────────────────────────────────────────────────────────────
  if (action === "guess") {
    const token = verifyToken<RouletteToken>(body.token);
    if (!token || token.userId !== userId)
      return NextResponse.json({ error: "Invalid or expired token." }, { status: 400 });

    const guess: string = (body.guess ?? "").toLowerCase().trim();
    const correct = token.word.toLowerCase().trim();
    const isCorrect = guess === correct;

    const MULTIPLIERS = { 3: 3, 2: 2, 1: 1.5 } as Record<number, number>;
    const mult = MULTIPLIERS[token.guessesLeft] ?? 1;

    if (isCorrect) {
      const winAmount = Math.floor(token.bet * mult);
      const { newBalance, isBankrupt } = await settleGame(
        userId,
        "wordroulette",
        token.bet,
        winAmount
      );
      return NextResponse.json({
        correct: true,
        word: correct,
        multiplier: mult,
        creditsChange: winAmount - token.bet,
        newBalance,
        isBankrupt,
      });
    }

    const newGuessesLeft = token.guessesLeft - 1;

    if (newGuessesLeft <= 0) {
      const { newBalance, isBankrupt } = await settleGame(
        userId,
        "wordroulette",
        token.bet,
        0
      );
      return NextResponse.json({
        correct: false,
        word: correct,
        creditsChange: -token.bet,
        newBalance,
        isBankrupt,
        gameOver: true,
      });
    }

    const newToken = signToken({
      word: token.word,
      bet: token.bet,
      guessesLeft: newGuessesLeft,
      userId,
    });

    return NextResponse.json({
      correct: false,
      guessesLeft: newGuessesLeft,
      token: newToken,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
