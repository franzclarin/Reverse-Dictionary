import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { signToken, verifyToken } from "@/lib/gameTokens";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { getRandomWords, checkGameRateLimit, validateBet } from "@/lib/gameUtils";

type SpeedToken = {
  words: string[];
  bet: number;
  userId: string;
  exp: number;
};

function calcMultiplier(correct: number): number {
  if (correct === 10) return 5;
  if (correct >= 8) return 3;
  if (correct >= 6) return 2;
  if (correct >= 4) return 1;
  return 0;
}

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

    const words = await getRandomWords(10);
    if (words.length < 4)
      return NextResponse.json(
        { error: "Need at least 4 words in the database." },
        { status: 400 }
      );

    const token = signToken({
      words: words.map((w) => w.word),
      bet,
      userId,
    });

    return NextResponse.json({
      questions: words.map((w) => ({
        definition: w.definition,
        partOfSpeech: w.partOfSpeech,
        hint: w.partOfSpeech,
      })),
      token,
      count: words.length,
    });
  }

  // ── SUBMIT ─────────────────────────────────────────────────────────────────
  if (action === "submit") {
    const token = verifyToken<SpeedToken>(body.token);
    if (!token || token.userId !== userId)
      return NextResponse.json(
        { error: "Invalid or expired token." },
        { status: 400 }
      );

    const answers: string[] = body.answers ?? [];
    const results = token.words.map((word, i) => ({
      word,
      guess: answers[i] ?? "",
      correct:
        (answers[i] ?? "").toLowerCase().trim() === word.toLowerCase().trim(),
    }));

    const correctCount = results.filter((r) => r.correct).length;
    const mult = calcMultiplier(correctCount);
    const winAmount = Math.floor(token.bet * mult);

    const { newBalance, isBankrupt } = await settleGame(
      userId,
      "speedround",
      token.bet,
      winAmount
    );

    return NextResponse.json({
      results,
      correctCount,
      total: token.words.length,
      multiplier: mult,
      creditsChange: winAmount - token.bet,
      newBalance,
      isBankrupt,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
