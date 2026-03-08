import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { checkGameRateLimit } from "@/lib/gameUtils";

export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { allowed } = await checkGameRateLimit(userId);
  if (!allowed)
    return NextResponse.json({ error: "Rate limit: max 60 rounds/hour." }, { status: 429 });

  const body = await req.json();
  const choice: string = body.choice;
  if (!["heads", "tails"].includes(choice))
    return NextResponse.json({ error: "Choose heads or tails." }, { status: 400 });

  const user = await getOrCreateUser(userId);

  let actualBet: number;
  if (body.bet === "allin") {
    actualBet = user.credits;
    if (actualBet < 10)
      return NextResponse.json({ error: "You need at least 10 credits to play." }, { status: 400 });
  } else {
    const raw = Number(body.bet);
    if (!Number.isInteger(raw) || raw < 10 || raw > 500)
      return NextResponse.json({ error: "Bet must be 10–500 credits." }, { status: 400 });
    if (user.credits < raw)
      return NextResponse.json({ error: "Insufficient credits." }, { status: 400 });
    actualBet = raw;
  }

  const result = Math.random() < 0.5 ? "heads" : "tails";
  const won = result === choice;
  const winAmount = won ? actualBet * 2 : 0;

  const { newBalance, isBankrupt } = await settleGame(userId, "coinflip", actualBet, winAmount);

  return NextResponse.json({
    result,
    won,
    bet: actualBet,
    creditsChange: won ? actualBet : -actualBet,
    newBalance,
    isBankrupt,
  });
}
