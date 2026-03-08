import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { signToken, verifyToken } from "@/lib/gameTokens";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { checkGameRateLimit, validateBet } from "@/lib/gameUtils";

// Ordered lowest to highest: 2 through A
const VALUES = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const SUITS = ["S","H","D","C"];

function createDeck(): string[] {
  const deck: string[] = [];
  for (const s of SUITS) for (const v of VALUES) deck.push(v + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardRank(card: string): number {
  return VALUES.indexOf(card.slice(0, -1));
}

function getMultiplier(streak: number): number {
  if (streak >= 10) return 10;
  if (streak >= 7) return 5.0;
  if (streak >= 5) return 3.2;
  if (streak >= 3) return 1.8;
  return 1.2;
}

type HiLoToken = {
  deck: string[];
  currentCard: string;
  streak: number;
  bet: number;
  userId: string;
  exp: number;
};

export async function POST(req: NextRequest) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { allowed } = await checkGameRateLimit(userId);
  if (!allowed)
    return NextResponse.json({ error: "Rate limit: max 60 rounds/hour." }, { status: 429 });

  const body = await req.json();
  const action: string = body.action;

  // ── DEAL ──────────────────────────────────────────────────────────────────
  if (action === "deal") {
    const bet = validateBet(body.bet);
    if (!bet)
      return NextResponse.json({ error: "Bet must be 10–500 credits." }, { status: 400 });

    const user = await getOrCreateUser(userId);
    if (user.credits < bet)
      return NextResponse.json({ error: "Insufficient credits." }, { status: 400 });

    const deck = createDeck();
    const currentCard = deck.pop()!;
    const token = signToken({ deck, currentCard, streak: 0, bet, userId });

    return NextResponse.json({
      currentCard,
      streak: 0,
      multiplier: getMultiplier(0),
      token,
    });
  }

  // ── GUESS ─────────────────────────────────────────────────────────────────
  if (action === "guess") {
    const token = verifyToken<HiLoToken>(body.token);
    if (!token || token.userId !== userId)
      return NextResponse.json({ error: "Invalid or expired token." }, { status: 400 });

    const { deck, currentCard, streak, bet } = token;
    const guess: string = body.guess; // "higher" | "lower" | "cashout"

    if (guess === "cashout") {
      const mult = getMultiplier(streak);
      const winAmount = Math.floor(bet * mult);
      const { newBalance, isBankrupt } = await settleGame(userId, "hilo", bet, winAmount);
      return NextResponse.json({
        phase: "resolved",
        outcome: "cashout",
        currentCard,
        streak,
        multiplier: mult,
        creditsChange: winAmount - bet,
        newBalance,
        isBankrupt,
      });
    }

    if (!["higher", "lower"].includes(guess))
      return NextResponse.json({ error: "Invalid guess." }, { status: 400 });

    const newDeck = [...deck];
    const nextCard = newDeck.pop()!;
    const cur = cardRank(currentCard);
    const nxt = cardRank(nextCard);

    const correct = nxt === cur // tie counts as correct
      || (guess === "higher" && nxt > cur)
      || (guess === "lower" && nxt < cur);

    if (!correct) {
      const { newBalance, isBankrupt } = await settleGame(userId, "hilo", bet, 0);
      return NextResponse.json({
        phase: "resolved",
        outcome: "lose",
        currentCard,
        nextCard,
        streak,
        creditsChange: -bet,
        newBalance,
        isBankrupt,
      });
    }

    const newStreak = streak + 1;

    // Deck nearly empty — force cashout
    if (newDeck.length < 2) {
      const mult = getMultiplier(newStreak);
      const winAmount = Math.floor(bet * mult);
      const { newBalance, isBankrupt } = await settleGame(userId, "hilo", bet, winAmount);
      return NextResponse.json({
        phase: "resolved",
        outcome: "cashout",
        currentCard,
        nextCard,
        streak: newStreak,
        multiplier: mult,
        creditsChange: winAmount - bet,
        newBalance,
        isBankrupt,
      });
    }

    const newToken = signToken({ deck: newDeck, currentCard: nextCard, streak: newStreak, bet, userId });
    return NextResponse.json({
      phase: "playing",
      currentCard: nextCard,
      prevCard: currentCard,
      streak: newStreak,
      multiplier: getMultiplier(newStreak),
      token: newToken,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
