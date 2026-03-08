import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { signToken, verifyToken } from "@/lib/gameTokens";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { checkGameRateLimit, validateBet } from "@/lib/gameUtils";

type DiceToken = { point: number; bet: number; userId: string; exp: number };

function rollDice(): [number, number] {
  return [
    Math.floor(Math.random() * 6) + 1,
    Math.floor(Math.random() * 6) + 1,
  ];
}

export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { allowed } = await checkGameRateLimit(userId);
  if (!allowed)
    return NextResponse.json({ error: "Rate limit: max 60 rounds/hour." }, { status: 429 });

  const body = await req.json();
  const action: string = body.action;

  // ── COME-OUT ROLL ──────────────────────────────────────────────────────────
  if (action === "comeout") {
    const bet = validateBet(body.bet);
    if (!bet)
      return NextResponse.json({ error: "Bet must be 10–500 credits." }, { status: 400 });

    const user = await getOrCreateUser(userId);
    if (user.credits < bet)
      return NextResponse.json({ error: "Insufficient credits." }, { status: 400 });

    const [d1, d2] = rollDice();
    const sum = d1 + d2;

    if (sum === 7 || sum === 11) {
      const { newBalance, isBankrupt } = await settleGame(userId, "dice", bet, bet * 2);
      return NextResponse.json({
        dice: [d1, d2], sum, phase: "resolved", outcome: "win",
        creditsChange: bet, newBalance, isBankrupt,
      });
    }
    if (sum === 2 || sum === 3 || sum === 12) {
      const { newBalance, isBankrupt } = await settleGame(userId, "dice", bet, 0);
      return NextResponse.json({
        dice: [d1, d2], sum, phase: "resolved", outcome: "lose",
        creditsChange: -bet, newBalance, isBankrupt,
      });
    }

    const token = signToken({ point: sum, bet, userId });
    return NextResponse.json({ dice: [d1, d2], sum, phase: "point", point: sum, token });
  }

  // ── POINT ROLL ─────────────────────────────────────────────────────────────
  if (action === "roll") {
    const token = verifyToken<DiceToken>(body.token);
    if (!token || token.userId !== userId)
      return NextResponse.json({ error: "Invalid or expired token." }, { status: 400 });

    const [d1, d2] = rollDice();
    const sum = d1 + d2;

    if (sum === token.point) {
      const { newBalance, isBankrupt } = await settleGame(userId, "dice", token.bet, token.bet * 2);
      return NextResponse.json({
        dice: [d1, d2], sum, phase: "resolved", outcome: "win",
        point: token.point, creditsChange: token.bet, newBalance, isBankrupt,
      });
    }
    if (sum === 7) {
      const { newBalance, isBankrupt } = await settleGame(userId, "dice", token.bet, 0);
      return NextResponse.json({
        dice: [d1, d2], sum, phase: "resolved", outcome: "lose",
        point: token.point, creditsChange: -token.bet, newBalance, isBankrupt,
      });
    }

    const newToken = signToken({ point: token.point, bet: token.bet, userId });
    return NextResponse.json({
      dice: [d1, d2], sum, phase: "point", point: token.point, token: newToken,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
