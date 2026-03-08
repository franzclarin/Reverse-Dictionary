import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { signToken, verifyToken } from "@/lib/gameTokens";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { getRandomWords, checkGameRateLimit, validateBet } from "@/lib/gameUtils";

type HLToken = {
  wordA: string;
  wordB: string;
  scoreA: number;
  scoreB: number;
  higherIdx: number; // 0 = A is more obscure, 1 = B is more obscure
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

  // ── PAIR ───────────────────────────────────────────────────────────────────
  if (action === "pair") {
    const words = await getRandomWords(2);
    if (words.length < 2)
      return NextResponse.json(
        { error: "Need at least 2 words in the database." },
        { status: 400 }
      );

    const [a, b] = words;
    const scoreA = a.obscurityScore;
    const scoreB = b.obscurityScore;

    // If tied, randomly pick one as "more obscure" for the round
    const higherIdx =
      scoreA === scoreB
        ? Math.random() < 0.5
          ? 0
          : 1
        : scoreA > scoreB
          ? 0
          : 1;

    const token = signToken({
      wordA: a.word,
      wordB: b.word,
      scoreA,
      scoreB,
      higherIdx,
      userId,
    });

    return NextResponse.json({
      words: [
        { word: a.word, partOfSpeech: a.partOfSpeech },
        { word: b.word, partOfSpeech: b.partOfSpeech },
      ],
      token,
    });
  }

  // ── ANSWER ─────────────────────────────────────────────────────────────────
  if (action === "answer") {
    const token = verifyToken<HLToken>(body.token);
    if (!token || token.userId !== userId)
      return NextResponse.json(
        { error: "Invalid or expired token." },
        { status: 400 }
      );

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

    const chosenIdx: number = body.choice; // 0 = chose A, 1 = chose B
    const isCorrect = chosenIdx === token.higherIdx;

    // Streak bonus: streak stored in body, verified loosely (client reports it)
    const streak: number = Number(body.streak) || 0;
    const mult = streak >= 5 ? 2 : 1.5;
    const winAmount = isCorrect ? Math.floor(bet * mult) : 0;

    const { newBalance, isBankrupt } = await settleGame(
      userId,
      "higherlower",
      bet,
      winAmount
    );

    return NextResponse.json({
      correct: isCorrect,
      higherIdx: token.higherIdx,
      scores: [token.scoreA, token.scoreB],
      words: [token.wordA, token.wordB],
      multiplier: isCorrect ? mult : 0,
      creditsChange: winAmount - bet,
      newBalance,
      isBankrupt,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
