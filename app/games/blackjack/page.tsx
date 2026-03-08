"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

type Phase = "bet" | "player_turn" | "resolved";

type BJResponse = {
  phase: string;
  playerHands: string[][];
  dealerHand: string[];
  bets: number[];
  handIndex?: number;
  token?: string;
  outcomes?: string[];
  netChange?: number;
  newBalance?: number;
  isBankrupt?: boolean;
};

const BET_PRESETS = [25, 50, 100, 250];

const TEN_CARDS = new Set(["T","J","Q","K"]);

const bjAnim = `
@keyframes cardDeal {
  from { opacity: 0; transform: translateY(-24px) scale(0.9); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes winGlow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(201,168,76,0); }
  50%       { box-shadow: 0 0 32px 8px rgba(201,168,76,0.3); }
}
@keyframes loseFlash {
  0%, 100% { background: var(--surface); }
  50%       { background: rgba(224,82,82,0.15); }
}
`;

function handTotal(hand: string[]): number {
  let total = 0, aces = 0;
  for (const c of hand) {
    if (c === "??") continue;
    const v = c.slice(0, -1);
    if (v === "A") { total += 11; aces++; }
    else if (TEN_CARDS.has(v)) total += 10;
    else total += parseInt(v);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
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

function displayValue(v: string) { return v === "T" ? "10" : v; }
function suitSymbol(s: string) { return { S: "♠", H: "♥", D: "♦", C: "♣" }[s] ?? s; }
function isRed(card: string) { const s = card.slice(-1); return s === "H" || s === "D"; }

function PlayingCard({ card, delay = 0 }: { card: string; delay?: number }) {
  if (card === "??") {
    return (
      <div style={{
        width: 60, height: 84, borderRadius: 7,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "center",
        animation: `cardDeal 0.25s ease-out ${delay}ms backwards`,
      }}>
        <span style={{ color: "var(--accent-gold)", fontSize: 22 }}>◈</span>
      </div>
    );
  }

  const v = card.slice(0, -1);
  const s = card.slice(-1);
  const red = isRed(card);
  const color = red ? "var(--confidence-low)" : "var(--text-primary)";

  return (
    <div style={{
      width: 60, height: 84, borderRadius: 7,
      background: "var(--surface-2)",
      border: "1px solid var(--border)",
      display: "flex", flexDirection: "column",
      padding: "5px 7px",
      position: "relative",
      animation: `cardDeal 0.25s ease-out ${delay}ms backwards`,
    }}>
      <span style={{ color, fontSize: 13, fontFamily: "monospace", lineHeight: 1 }}>{displayValue(v)}</span>
      <span style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        color, fontSize: 24,
      }}>{suitSymbol(s)}</span>
      <span style={{
        position: "absolute", bottom: 5, right: 7,
        color, fontSize: 13, fontFamily: "monospace",
        transform: "rotate(180deg)",
      }}>{displayValue(v)}</span>
    </div>
  );
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "blackjack": return "var(--accent-gold)";
    case "win": return "var(--confidence-high)";
    case "push": return "var(--text-secondary)";
    default: return "var(--confidence-low)";
  }
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "blackjack": return "BLACKJACK! 🎉";
    case "win": return "WIN";
    case "push": return "PUSH";
    case "bust": return "BUST";
    default: return "LOSE";
  }
}

export default function BlackjackPage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(50);
  const [gameState, setGameState] = useState<BJResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!isSignedIn) {
    return (
      <main className="max-w-xl mx-auto px-6 py-12 text-center">
        <p className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>Sign in to play.</p>
        <Link href="/games" className="font-mono text-xs mt-4 inline-block" style={{ color: "var(--accent-gold)" }}>← Back to Games</Link>
      </main>
    );
  }

  async function callApi(body: Record<string, unknown>) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/games/blackjack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as BJResponse & { error?: string };
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      setGameState(data);
      setPhase(data.phase === "resolved" ? "resolved" : "player_turn");
    } finally {
      setLoading(false);
    }
  }

  function deal() { callApi({ action: "deal", bet }); }
  function hit() { callApi({ action: "hit", token: gameState?.token }); }
  function stand() { callApi({ action: "stand", token: gameState?.token }); }
  function doubleDown() { callApi({ action: "double", token: gameState?.token }); }
  function split() { callApi({ action: "split", token: gameState?.token }); }

  function reset() {
    setPhase("bet");
    setGameState(null);
    setError("");
  }

  const gs = gameState;
  const handIdx = gs?.handIndex ?? 0;
  const activeHand = gs?.playerHands?.[handIdx] ?? [];
  const canDouble = phase === "player_turn" && activeHand.length === 2;
  const canSplit = phase === "player_turn" && activeHand.length === 2 && isPair(activeHand);

  // Net change sign
  const netChange = gs?.netChange ?? 0;

  // Check if any outcome was a win for animation
  const anyWin = gs?.outcomes?.some(o => o === "win" || o === "blackjack");
  const anyLoss = gs?.outcomes?.some(o => o === "bust" || o === "lose");

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <style>{bjAnim}</style>

      <div className="mb-8">
        <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>← Games</Link>
        <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>Blackjack</h1>
        <p className="font-mono text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>6-deck shoe · Dealer hits soft 17 · BJ pays 3:2</p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded font-mono text-xs" style={{ background: "#3a1a1a", color: "var(--confidence-low)", border: "1px solid #5a2a2a" }}>
          {error}
        </div>
      )}

      {/* BET PHASE */}
      {phase === "bet" && (
        <div>
          <div className="p-5 rounded mb-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <p className="font-mono text-xs mb-3" style={{ color: "var(--accent-gold)" }}>PAYOUTS</p>
            {[
              ["Blackjack", "3:2"],
              ["Win", "1:1"],
              ["Push", "Bet returned"],
              ["Lose", "−Bet"],
            ].map(([name, payout]) => (
              <div key={name} className="flex justify-between py-1">
                <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{name}</span>
                <span className="font-mono text-xs" style={{ color: "var(--accent-gold)" }}>{payout}</span>
              </div>
            ))}
          </div>

          <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)" }}>YOUR BET</p>
          <div className="flex gap-2 mb-4 flex-wrap">
            {BET_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setBet(p)}
                className="font-mono text-xs px-3 py-1.5 rounded transition-all"
                style={{
                  background: bet === p ? "var(--accent-gold)" : "var(--surface)",
                  color: bet === p ? "var(--bg)" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                {p}
              </button>
            ))}
            <input
              type="number" min={10} max={500} value={bet}
              onChange={(e) => setBet(Number(e.target.value))}
              className="font-mono text-xs px-3 py-1.5 rounded w-24"
              style={{ background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
            />
          </div>
          <p className="font-mono text-xs mb-6" style={{ color: "var(--text-secondary)" }}>Min: 10 · Max: 500</p>

          <button
            onClick={deal}
            disabled={loading || bet < 10 || bet > 500}
            className="font-mono text-sm px-6 py-2.5 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
          >
            {loading ? "Dealing…" : "DEAL →"}
          </button>
        </div>
      )}

      {/* PLAYER TURN & RESOLVED */}
      {(phase === "player_turn" || phase === "resolved") && gs && (
        <div>
          {/* Dealer hand */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>DEALER</p>
              {phase === "resolved" && (
                <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
                  {handTotal(gs.dealerHand)}
                </p>
              )}
            </div>
            <div className="flex gap-2 flex-wrap">
              {gs.dealerHand.map((card, i) => (
                <PlayingCard key={i} card={card} delay={i * 150} />
              ))}
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--border)", marginBottom: 20 }} />

          {/* Player hands */}
          {gs.playerHands.map((hand, hi) => {
            const isActive = phase === "player_turn" && hi === handIdx;
            const outcome = gs.outcomes?.[hi];
            const total = handTotal(hand);

            return (
              <div key={hi} className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-xs" style={{ color: isActive ? "var(--accent-gold)" : "var(--text-secondary)" }}>
                      {gs.playerHands.length > 1 ? `HAND ${hi + 1}` : "YOU"}
                      {isActive && " ← active"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {outcome && (
                      <span className="font-mono text-xs px-2 py-0.5 rounded" style={{
                        background: `${outcomeColor(outcome)}22`,
                        color: outcomeColor(outcome),
                        border: `1px solid ${outcomeColor(outcome)}`,
                      }}>
                        {outcomeLabel(outcome)}
                      </span>
                    )}
                    <p className="font-mono text-xs" style={{
                      color: total > 21 ? "var(--confidence-low)" : total === 21 ? "var(--accent-gold)" : "var(--text-secondary)",
                    }}>
                      {total > 21 ? "BUST" : total}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {hand.map((card, ci) => (
                    <PlayingCard key={ci} card={card} delay={(ci + 2) * 150} />
                  ))}
                </div>
                {gs.bets.length > 1 && (
                  <p className="font-mono text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
                    Bet: {gs.bets[hi]} ◈
                  </p>
                )}
              </div>
            );
          })}

          {/* Actions */}
          {phase === "player_turn" && (
            <div className="mt-4">
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={hit}
                  disabled={loading}
                  className="font-mono text-xs px-4 py-2 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
                  style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
                >
                  Hit
                </button>
                <button
                  onClick={stand}
                  disabled={loading}
                  className="font-mono text-xs px-4 py-2 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
                  style={{ background: "var(--surface-2)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
                >
                  Stand
                </button>
                {canDouble && (
                  <button
                    onClick={doubleDown}
                    disabled={loading}
                    className="font-mono text-xs px-4 py-2 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
                    style={{ background: "var(--surface-2)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
                  >
                    Double Down
                  </button>
                )}
                {canSplit && (
                  <button
                    onClick={split}
                    disabled={loading}
                    className="font-mono text-xs px-4 py-2 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
                    style={{ background: "var(--surface-2)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
                  >
                    Split
                  </button>
                )}
              </div>
              <p className="font-mono text-xs mt-2" style={{ color: "var(--text-secondary)" }}>
                Betting {bet} ◈
              </p>
            </div>
          )}

          {/* Resolved summary */}
          {phase === "resolved" && (
            <div
              className="mt-6 p-5 rounded"
              style={{
                background: "var(--surface)",
                border: `1px solid ${anyWin ? "var(--accent-gold)" : anyLoss ? "var(--confidence-low)" : "var(--border)"}`,
                animation: anyWin ? "winGlow 1.5s ease-in-out 2" : anyLoss ? "loseFlash 0.5s ease-in-out 2" : "none",
              }}
            >
              {gs.playerHands.length === 1 ? (
                <div className="text-center">
                  {gs.outcomes?.[0] === "blackjack" && (
                    <p className="font-serif text-3xl mb-1" style={{ color: "var(--accent-gold)" }}>Blackjack! 🎉</p>
                  )}
                  {gs.outcomes?.[0] === "win" && (
                    <p className="font-serif text-3xl mb-1" style={{ color: "var(--confidence-high)" }}>You win!</p>
                  )}
                  {gs.outcomes?.[0] === "push" && (
                    <p className="font-serif text-3xl mb-1" style={{ color: "var(--text-secondary)" }}>Push.</p>
                  )}
                  {(gs.outcomes?.[0] === "bust" || gs.outcomes?.[0] === "lose") && (
                    <p className="font-serif text-3xl mb-1" style={{ color: "var(--confidence-low)" }}>
                      {gs.outcomes?.[0] === "bust" ? "Bust." : "Dealer wins."}
                    </p>
                  )}
                  <p className="font-mono text-sm" style={{ color: netChange > 0 ? "var(--accent-gold)" : netChange < 0 ? "var(--confidence-low)" : "var(--text-secondary)" }}>
                    {netChange > 0 ? "+" : ""}{netChange} ◈
                  </p>
                </div>
              ) : (
                <div>
                  <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)" }}>RESULTS</p>
                  {gs.playerHands.map((_, hi) => (
                    <div key={hi} className="flex justify-between py-1">
                      <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>Hand {hi + 1}</span>
                      <span className="font-mono text-xs" style={{ color: outcomeColor(gs.outcomes?.[hi] ?? "") }}>
                        {outcomeLabel(gs.outcomes?.[hi] ?? "")}
                      </span>
                    </div>
                  ))}
                  <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
                    <div className="flex justify-between">
                      <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>Net</span>
                      <span className="font-mono text-xs" style={{ color: netChange > 0 ? "var(--accent-gold)" : netChange < 0 ? "var(--confidence-low)" : "var(--text-secondary)" }}>
                        {netChange > 0 ? "+" : ""}{netChange} ◈
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {gs.isBankrupt && (
                <p className="font-mono text-xs mt-3 text-center" style={{ color: "var(--accent-gold)" }}>
                  The house always wins. Here's 25 ◈ to get back in the game.
                </p>
              )}
              <p className="font-mono text-xs mt-2 text-center" style={{ color: "var(--text-secondary)" }}>
                Balance: {gs.newBalance?.toLocaleString()} ◈
              </p>

              <div className="flex gap-3 justify-center mt-5">
                <button onClick={reset} className="font-mono text-sm px-5 py-2 rounded transition-opacity hover:opacity-90" style={{ background: "var(--accent-gold)", color: "var(--bg)" }}>
                  New Hand
                </button>
                <Link href="/games" className="font-mono text-sm px-5 py-2 rounded" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                  Games Lobby
                </Link>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
