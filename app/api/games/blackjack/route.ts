import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { signToken, verifyToken } from "@/lib/gameTokens";
import { getOrCreateUser, settleGame } from "@/lib/credits";
import { checkGameRateLimit, validateBet } from "@/lib/gameUtils";

const VALUES = ["A","2","3","4","5","6","7","8","9","T","J","Q","K"];
const SUITS = ["S","H","D","C"];
const TEN_CARDS = new Set(["T","J","Q","K"]);

function createShoe(numDecks = 6): string[] {
  const deck: string[] = [];
  for (let d = 0; d < numDecks; d++)
    for (const s of SUITS)
      for (const v of VALUES)
        deck.push(v + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handTotal(hand: string[]): { total: number; soft: boolean } {
  let total = 0, aces = 0;
  for (const c of hand) {
    const v = c.slice(0, -1);
    if (v === "A") { total += 11; aces++; }
    else if (TEN_CARDS.has(v)) total += 10;
    else total += parseInt(v);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 && total <= 21 };
}

function isNatural(hand: string[]): boolean {
  if (hand.length !== 2) return false;
  const vals = hand.map(c => c.slice(0, -1));
  return vals.includes("A") && vals.some(v => TEN_CARDS.has(v));
}

function isPair(hand: string[]): boolean {
  if (hand.length !== 2) return false;
  const rank = (v: string) => TEN_CARDS.has(v) ? 10 : (v === "A" ? 11 : parseInt(v));
  return rank(hand[0].slice(0, -1)) === rank(hand[1].slice(0, -1));
}

function dealerPlay(deck: string[], dealerHand: string[]): { hand: string[] } {
  const d = [...deck];
  const hand = [...dealerHand];
  while (true) {
    const { total, soft } = handTotal(hand);
    if (total < 17 || (total === 17 && soft)) hand.push(d.pop()!);
    else break;
  }
  return { hand };
}

function resolveHands(
  playerHands: string[][],
  bets: number[],
  dealerHand: string[],
  wasSingleHand: boolean
): { outcomes: string[]; netChange: number } {
  const { total: dealerTotal } = handTotal(dealerHand);
  const dealerBust = dealerTotal > 21;
  const dealerBJ = isNatural(dealerHand);
  let netChange = 0;
  const outcomes: string[] = [];

  for (let i = 0; i < playerHands.length; i++) {
    const hand = playerHands[i];
    const bet = bets[i];
    const { total } = handTotal(hand);
    const bust = total > 21;
    // Natural BJ only valid on the original unsplit hand
    const bj = isNatural(hand) && wasSingleHand;

    if (bust) {
      netChange -= bet; outcomes.push("bust");
    } else if (bj && !dealerBJ) {
      netChange += Math.floor(bet * 1.5); outcomes.push("blackjack");
    } else if (bj && dealerBJ) {
      outcomes.push("push");
    } else if (dealerBJ) {
      netChange -= bet; outcomes.push("lose");
    } else if (dealerBust || total > dealerTotal) {
      netChange += bet; outcomes.push("win");
    } else if (total === dealerTotal) {
      outcomes.push("push");
    } else {
      netChange -= bet; outcomes.push("lose");
    }
  }
  return { outcomes, netChange };
}

type BJToken = {
  deck: string[];
  dealerHand: string[];
  playerHands: string[][];
  bets: number[];
  handIndex: number;
  splitCount: number;
  originalHandCount: number;
  userId: string;
  exp: number;
};

async function finalize(
  userId: string,
  deck: string[],
  dealerHand: string[],
  playerHands: string[][],
  bets: number[],
  originalHandCount: number
) {
  const { hand: finalDealerHand } = dealerPlay(deck, dealerHand);
  const { outcomes, netChange } = resolveHands(playerHands, bets, finalDealerHand, originalHandCount === 1);
  const totalBet = bets.reduce((a, b) => a + b, 0);
  const winAmount = Math.max(0, totalBet + netChange);
  const { newBalance, isBankrupt } = await settleGame(userId, "blackjack", totalBet, winAmount);
  return { phase: "resolved", playerHands, dealerHand: finalDealerHand, bets, outcomes, netChange, newBalance, isBankrupt };
}

function nextPlayable(hands: string[][], startIdx: number): number {
  let idx = startIdx;
  while (idx < hands.length && handTotal(hands[idx]).total >= 21) idx++;
  return idx;
}

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
    if (!bet) return NextResponse.json({ error: "Bet must be 10–500 credits." }, { status: 400 });

    const user = await getOrCreateUser(userId);
    if (user.credits < bet)
      return NextResponse.json({ error: "Insufficient credits." }, { status: 400 });

    const deck = createShoe();
    const p0 = deck.pop()!, d0 = deck.pop()!, p1 = deck.pop()!, d1 = deck.pop()!;
    const playerHand = [p0, p1];
    const dealerHand = [d0, d1];

    const playerBJ = isNatural(playerHand);
    const dealerBJ = isNatural(dealerHand);

    if (playerBJ || dealerBJ) {
      let outcome: string, winAmount: number;
      if (playerBJ && !dealerBJ) { outcome = "blackjack"; winAmount = bet + Math.floor(bet * 1.5); }
      else if (dealerBJ && !playerBJ) { outcome = "lose"; winAmount = 0; }
      else { outcome = "push"; winAmount = bet; }
      const { newBalance, isBankrupt } = await settleGame(userId, "blackjack", bet, winAmount);
      return NextResponse.json({
        phase: "resolved", playerHands: [playerHand], dealerHand, bets: [bet],
        outcomes: [outcome], netChange: winAmount - bet, newBalance, isBankrupt,
      });
    }

    const token = signToken({
      deck, dealerHand, playerHands: [playerHand], bets: [bet],
      handIndex: 0, splitCount: 0, originalHandCount: 1, userId,
    });
    return NextResponse.json({
      phase: "player_turn",
      playerHands: [playerHand],
      dealerHand: [dealerHand[0], "??"],
      bets: [bet],
      handIndex: 0,
      token,
    });
  }

  // All other actions require a valid token
  const tok = verifyToken<BJToken>(body.token);
  if (!tok || tok.userId !== userId)
    return NextResponse.json({ error: "Invalid or expired token." }, { status: 400 });

  const { deck, dealerHand, playerHands, bets, handIndex, splitCount, originalHandCount } = tok;

  // ── HIT ───────────────────────────────────────────────────────────────────
  if (action === "hit") {
    const newDeck = [...deck];
    const card = newDeck.pop()!;
    const newHands = playerHands.map((h, i) => i === handIndex ? [...h, card] : h);
    const { total } = handTotal(newHands[handIndex]);

    const nextIdx = nextPlayable(newHands, total >= 21 ? handIndex + 1 : handIndex);
    if (nextIdx > handIndex && total < 21) {
      // still on same hand, not busted — shouldn't happen, but guard
    }
    const shouldAdvance = total >= 21 || nextIdx !== handIndex;

    if (nextIdx >= newHands.length) {
      return NextResponse.json(
        await finalize(userId, newDeck, dealerHand, newHands, bets, originalHandCount)
      );
    }

    const nextHandIdx = shouldAdvance ? nextIdx : handIndex;
    const newToken = signToken({
      deck: newDeck, dealerHand, playerHands: newHands, bets,
      handIndex: nextHandIdx, splitCount, originalHandCount, userId,
    });
    return NextResponse.json({
      phase: "player_turn",
      playerHands: newHands,
      dealerHand: [dealerHand[0], "??"],
      bets,
      handIndex: nextHandIdx,
      token: newToken,
    });
  }

  // ── STAND ─────────────────────────────────────────────────────────────────
  if (action === "stand") {
    const nextIdx = nextPlayable(playerHands, handIndex + 1);
    if (nextIdx >= playerHands.length) {
      return NextResponse.json(
        await finalize(userId, [...deck], dealerHand, playerHands, bets, originalHandCount)
      );
    }
    const newToken = signToken({
      deck, dealerHand, playerHands, bets,
      handIndex: nextIdx, splitCount, originalHandCount, userId,
    });
    return NextResponse.json({
      phase: "player_turn",
      playerHands,
      dealerHand: [dealerHand[0], "??"],
      bets,
      handIndex: nextIdx,
      token: newToken,
    });
  }

  // ── DOUBLE DOWN ───────────────────────────────────────────────────────────
  if (action === "double") {
    if (playerHands[handIndex].length !== 2)
      return NextResponse.json({ error: "Can only double on first two cards." }, { status: 400 });

    const newBets = bets.map((b, i) => i === handIndex ? b * 2 : b);
    const newTotalBet = newBets.reduce((a, b) => a + b, 0);
    const user = await getOrCreateUser(userId);
    if (user.credits < newTotalBet)
      return NextResponse.json({ error: "Insufficient credits to double." }, { status: 400 });

    const newDeck = [...deck];
    const card = newDeck.pop()!;
    const newHands = playerHands.map((h, i) => i === handIndex ? [...h, card] : h);

    // After double, must stand on this hand
    const nextIdx = nextPlayable(newHands, handIndex + 1);
    if (nextIdx >= newHands.length) {
      return NextResponse.json(
        await finalize(userId, newDeck, dealerHand, newHands, newBets, originalHandCount)
      );
    }
    const newToken = signToken({
      deck: newDeck, dealerHand, playerHands: newHands, bets: newBets,
      handIndex: nextIdx, splitCount, originalHandCount, userId,
    });
    return NextResponse.json({
      phase: "player_turn",
      playerHands: newHands,
      dealerHand: [dealerHand[0], "??"],
      bets: newBets,
      handIndex: nextIdx,
      token: newToken,
    });
  }

  // ── SPLIT ─────────────────────────────────────────────────────────────────
  if (action === "split") {
    const currentHand = playerHands[handIndex];
    if (currentHand.length !== 2 || !isPair(currentHand))
      return NextResponse.json({ error: "Can only split pairs." }, { status: 400 });
    if (splitCount >= 3)
      return NextResponse.json({ error: "Maximum 3 splits reached." }, { status: 400 });

    const currentBet = bets[handIndex];
    const newBets = [
      ...bets.slice(0, handIndex),
      currentBet, currentBet,
      ...bets.slice(handIndex + 1),
    ];
    const newTotalBet = newBets.reduce((a, b) => a + b, 0);
    const user = await getOrCreateUser(userId);
    if (user.credits < newTotalBet)
      return NextResponse.json({ error: "Insufficient credits to split." }, { status: 400 });

    const newDeck = [...deck];
    const c1 = newDeck.pop()!, c2 = newDeck.pop()!;
    const newHands = [
      ...playerHands.slice(0, handIndex),
      [currentHand[0], c1],
      [currentHand[1], c2],
      ...playerHands.slice(handIndex + 1),
    ];

    // Split aces: one card each, then auto-resolve
    if (currentHand[0].slice(0, -1) === "A") {
      return NextResponse.json(
        await finalize(userId, newDeck, dealerHand, newHands, newBets, originalHandCount)
      );
    }

    const newToken = signToken({
      deck: newDeck, dealerHand, playerHands: newHands, bets: newBets,
      handIndex, splitCount: splitCount + 1, originalHandCount, userId,
    });
    return NextResponse.json({
      phase: "player_turn",
      playerHands: newHands,
      dealerHand: [dealerHand[0], "??"],
      bets: newBets,
      handIndex,
      token: newToken,
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
