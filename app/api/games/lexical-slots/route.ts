import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { getRandomWords, checkGameRateLimit, validateBet } from "@/lib/gameUtils";

type SlotResult = "triple" | "domain" | "pos" | "none";

function evaluateReels(
  words: { word: string; domain: string; partOfSpeech: string }[]
): { result: SlotResult; multiplier: number } {
  const [a, b, c] = words;
  if (a.word === b.word && b.word === c.word)
    return { result: "triple", multiplier: 10 };
  if (a.domain === b.domain && b.domain === c.domain)
    return { result: "domain", multiplier: 4 };
  if (a.partOfSpeech === b.partOfSpeech && b.partOfSpeech === c.partOfSpeech)
    return { result: "pos", multiplier: 2 };
  return { result: "none", multiplier: 0 };
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

  const words = await getRandomWords(3);
  if (words.length < 3)
    return NextResponse.json(
      { error: "Need at least 3 words in the database. Add more first!" },
      { status: 400 }
    );

  // For a triple, occasionally force it (5% chance) for fun
  const forceTriple = Math.random() < 0.05;
  const reels = forceTriple ? [words[0], words[0], words[0]] : words;

  const { result, multiplier } = evaluateReels(reels);
  const winAmount = Math.floor(bet * multiplier);

  const { newBalance, isBankrupt } = await settleGame(
    userId,
    "slots",
    bet,
    winAmount
  );

  return NextResponse.json({
    reels: reels.map((w) => ({
      word: w.word,
      domain: w.domain,
      partOfSpeech: w.partOfSpeech,
    })),
    result,
    multiplier,
    creditsChange: winAmount - bet,
    newBalance,
    isBankrupt,
  });
}
