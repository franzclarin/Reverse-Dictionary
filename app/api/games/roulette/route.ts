import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { checkGameRateLimit, validateBet } from "@/lib/gameUtils";

const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

// Returns the payout multiplier (1 = 1:1, 35 = 35:1, etc.) or -1 for a loss
function evaluate(betType: string, number: number, straightUpNumber?: number): number {
  if (number === 0) {
    if (betType === "green") return 14;
    if (betType === "straight" && straightUpNumber === 0) return 35;
    return -1;
  }
  switch (betType) {
    case "red":    return RED_NUMBERS.has(number) ? 1 : -1;
    case "black":  return !RED_NUMBERS.has(number) ? 1 : -1;
    case "odd":    return number % 2 === 1 ? 1 : -1;
    case "even":   return number % 2 === 0 ? 1 : -1;
    case "low":    return number <= 18 ? 1 : -1;
    case "high":   return number >= 19 ? 1 : -1;
    case "dozen1": return number <= 12 ? 2 : -1;
    case "dozen2": return number >= 13 && number <= 24 ? 2 : -1;
    case "dozen3": return number >= 25 ? 2 : -1;
    case "green":  return -1;
    case "straight": return straightUpNumber === number ? 35 : -1;
    default: return -1;
  }
}

const VALID_BET_TYPES = ["red","black","odd","even","low","high","dozen1","dozen2","dozen3","green","straight"];

export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { allowed } = await checkGameRateLimit(userId);
  if (!allowed)
    return NextResponse.json({ error: "Rate limit: max 60 rounds/hour." }, { status: 429 });

  const body = await req.json();
  const bet = validateBet(body.bet);
  if (!bet)
    return NextResponse.json({ error: "Bet must be 10–500 credits." }, { status: 400 });

  const betType: string = body.betType;
  if (!VALID_BET_TYPES.includes(betType))
    return NextResponse.json({ error: "Invalid bet type." }, { status: 400 });

  let straightUpNumber: number | undefined;
  if (betType === "straight") {
    straightUpNumber = parseInt(body.straightUpNumber);
    if (isNaN(straightUpNumber) || straightUpNumber < 0 || straightUpNumber > 36)
      return NextResponse.json({ error: "Straight up number must be 0–36." }, { status: 400 });
  }

  const user = await getOrCreateUser(userId);
  if (user.credits < bet)
    return NextResponse.json({ error: "Insufficient credits." }, { status: 400 });

  const result = Math.floor(Math.random() * 37); // 0–36
  const multiplier = evaluate(betType, result, straightUpNumber);
  const won = multiplier > 0;
  const winAmount = won ? bet + bet * multiplier : 0;
  const creditsChange = won ? bet * multiplier : -bet;
  const color = result === 0 ? "green" : RED_NUMBERS.has(result) ? "red" : "black";

  const { newBalance, isBankrupt } = await settleGame(userId, "roulette", bet, winAmount);

  return NextResponse.json({
    result,
    color,
    won,
    multiplier: won ? multiplier : 0,
    creditsChange,
    newBalance,
    isBankrupt,
  });
}
