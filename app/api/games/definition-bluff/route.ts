import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import Anthropic from "@anthropic-ai/sdk";
import { signToken, verifyToken } from "@/lib/gameTokens";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { getRandomWords, checkGameRateLimit, validateBet } from "@/lib/gameUtils";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type BluffToken = {
  correctId: string;
  word: string;
  bet: number;
  userId: string;
  exp: number;
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

    const words = await getRandomWords(1);
    if (!words.length)
      return NextResponse.json(
        { error: "No words in database yet." },
        { status: 400 }
      );

    const word = words[0];
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      temperature: 0.9,
      messages: [
        {
          role: "user",
          content: `For the word "${word.word}" with definition "${word.definition}", generate exactly 3 plausible but completely fabricated definitions that sound convincing. They should vary in tone: one academic, one poetic, one clinical. Return as JSON array of 3 strings. No preamble.`,
        },
      ],
    });

    const text =
      msg.content[0].type === "text" ? msg.content[0].text.trim() : "[]";
    let fakes: string[] = [];
    try {
      fakes = JSON.parse(text);
      if (!Array.isArray(fakes) || fakes.length !== 3) throw new Error();
    } catch {
      fakes = [
        "A rare form of cognitive dissonance experienced during solstices.",
        "The resonant frequency of hollow objects filled with morning air.",
        "Clinical term for the involuntary recall of unpleasant memories.",
      ];
    }

    const ids = ["A", "B", "C", "D"];
    const realId = ids[Math.floor(Math.random() * 4)];
    const fakeIds = ids.filter((id) => id !== realId);

    const optionsMap: Record<string, string> = {};
    optionsMap[realId] = word.definition;
    fakeIds.forEach((id, i) => {
      optionsMap[id] = fakes[i];
    });

    const options = ids.map((id) => ({ id, text: optionsMap[id] }));
    const shuffled = shuffle(options);

    const token = signToken({ correctId: realId, word: word.word, bet, userId });
    return NextResponse.json({ word: word.word, options: shuffled, token });
  }

  // ── SUBMIT ─────────────────────────────────────────────────────────────────
  if (action === "submit") {
    const token = verifyToken<BluffToken>(body.token);
    if (!token || token.userId !== userId)
      return NextResponse.json({ error: "Invalid or expired token." }, { status: 400 });

    const selectedId: string = body.selectedId;
    const isCorrect = selectedId === token.correctId;

    const winAmount = isCorrect ? token.bet * 2 : 0;
    const { newBalance, isBankrupt } = await settleGame(
      userId,
      "bluff",
      token.bet,
      winAmount
    );

    return NextResponse.json({
      correct: isCorrect,
      correctId: token.correctId,
      word: token.word,
      creditsChange: winAmount - token.bet,
      newBalance,
      isBankrupt,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
