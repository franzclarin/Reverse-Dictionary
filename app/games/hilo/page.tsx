"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

type Phase = "bet" | "playing" | "result";

type GuessResponse = {
  phase: "playing" | "resolved";
  outcome?: "win" | "lose" | "cashout";
  currentCard: string;
  nextCard?: string;
  prevCard?: string;
  streak: number;
  multiplier: number;
  creditsChange?: number;
  newBalance?: number;
  isBankrupt?: boolean;
  token?: string;
};

const BET_PRESETS = [25, 50, 100, 250];

// Card value order: 2 lowest, A highest
const VALUE_ORDER = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];

const cardAnim = `
@keyframes cardSlideIn {
  from { opacity: 0; transform: translateY(-20px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;

function displayValue(v: string) {
  return v === "T" ? "10" : v;
}

function suitSymbol(s: string) {
  return { S: "♠", H: "♥", D: "♦", C: "♣" }[s] ?? s;
}

function isRed(card: string) {
  const s = card.slice(-1);
  return s === "H" || s === "D";
}

function PlayingCard({ card, highlight = false, dimmed = false }: { card: string; highlight?: boolean; dimmed?: boolean }) {
  const v = card.slice(0, -1);
  const s = card.slice(-1);
  const red = isRed(card);
  const color = red ? "var(--confidence-low)" : "var(--text-primary)";

  return (
    <div style={{
      width: 72, height: 100,
      background: dimmed ? "var(--surface)" : "var(--surface-2)",
      border: `2px solid ${highlight ? "var(--accent-gold)" : "var(--border)"}`,
      borderRadius: 8,
      display: "flex",
      flexDirection: "column",
      padding: "6px 8px",
      position: "relative",
      opacity: dimmed ? 0.5 : 1,
      animation: highlight ? "cardSlideIn 0.25s ease-out" : "none",
      boxShadow: highlight ? "0 0 16px rgba(201,168,76,0.2)" : "none",
    }}>
      <span style={{ color, fontSize: 14, fontFamily: "monospace", lineHeight: 1 }}>{displayValue(v)}</span>
      <span style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        color, fontSize: 28,
      }}>{suitSymbol(s)}</span>
      <span style={{
        position: "absolute", bottom: 6, right: 8,
        color, fontSize: 14, fontFamily: "monospace",
        transform: "rotate(180deg)",
      }}>{displayValue(v)}</span>
    </div>
  );
}

function multiplierColor(m: number) {
  if (m >= 5) return "var(--confidence-high)";
  if (m >= 2) return "var(--accent-gold)";
  return "var(--text-secondary)";
}

export default function HiLoPage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(50);
  const [currentCard, setCurrentCard] = useState<string | null>(null);
  const [prevCard, setPrevCard] = useState<string | null>(null);
  const [streak, setStreak] = useState(0);
  const [multiplier, setMultiplier] = useState(1.2);
  const [token, setToken] = useState<string | null>(null);
  const [result, setResult] = useState<GuessResponse | null>(null);
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

  async function deal() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/games/hilo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deal", bet }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      setCurrentCard(data.currentCard);
      setPrevCard(null);
      setStreak(0);
      setMultiplier(data.multiplier);
      setToken(data.token);
      setPhase("playing");
    } finally {
      setLoading(false);
    }
  }

  async function guess(g: "higher" | "lower" | "cashout") {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/games/hilo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "guess", guess: g, token }),
      });
      const data = await res.json() as GuessResponse & { error?: string };
      if (!res.ok) { setError(data.error ?? "Failed."); return; }

      if (data.phase === "resolved") {
        setResult(data);
        setPhase("result");
      } else {
        setPrevCard(currentCard);
        setCurrentCard(data.currentCard);
        setStreak(data.streak);
        setMultiplier(data.multiplier);
        setToken(data.token ?? null);
      }
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setPhase("bet");
    setResult(null);
    setCurrentCard(null);
    setPrevCard(null);
    setStreak(0);
    setMultiplier(1.2);
    setToken(null);
    setError("");
  }

  // Determine if current card is near middle of deck (for UI hint)
  const rankIdx = currentCard ? VALUE_ORDER.indexOf(currentCard.slice(0, -1)) : -1;

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <style>{cardAnim}</style>

      <div className="mb-8">
        <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>← Games</Link>
        <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>Hi-Lo</h1>
        <p className="font-mono text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>Higher or lower? Build a streak, then cash out.</p>
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
            <p className="font-mono text-xs mb-3" style={{ color: "var(--accent-gold)" }}>STREAK MULTIPLIERS</p>
            {[
              ["1+ correct", "1.2×"],
              ["3+ correct", "1.8×"],
              ["5+ correct", "3.2×"],
              ["7+ correct", "5.0×"],
              ["10+ correct", "10×"],
            ].map(([streak, mult]) => (
              <div key={streak} className="flex justify-between py-1">
                <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{streak}</span>
                <span className="font-mono text-xs" style={{ color: "var(--accent-gold)" }}>{mult}</span>
              </div>
            ))}
            <p className="font-mono text-xs mt-3" style={{ color: "var(--text-secondary)" }}>
              Ties count as correct. Cash out any time.
            </p>
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
            {loading ? "Dealing…" : "DEAL CARD →"}
          </button>
        </div>
      )}

      {/* PLAYING PHASE */}
      {phase === "playing" && currentCard && (
        <div>
          {/* Streak & multiplier */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>STREAK</p>
              <p className="font-serif text-2xl" style={{ color: "var(--accent-gold)" }}>
                {streak > 0 ? `🔥 ${streak}` : "0"}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>MULTIPLIER</p>
              <p className="font-serif text-2xl" style={{ color: multiplierColor(multiplier) }}>
                {multiplier}×
              </p>
            </div>
          </div>

          {/* Cards */}
          <div className="flex items-center justify-center gap-6 mb-6">
            {prevCard && <PlayingCard card={prevCard} dimmed />}
            {prevCard && (
              <span style={{ color: "var(--text-secondary)", fontSize: 20 }}>→</span>
            )}
            {currentCard && <PlayingCard card={currentCard} highlight />}
          </div>

          {/* Scale hint */}
          <div className="mb-6">
            <div className="flex justify-between font-mono text-xs mb-1" style={{ color: "var(--text-secondary)" }}>
              <span>2 (lowest)</span>
              <span>A (highest)</span>
            </div>
            <div style={{ height: 4, background: "var(--surface-2)", borderRadius: 2, position: "relative" }}>
              <div style={{
                position: "absolute",
                width: 12, height: 12, borderRadius: "50%",
                background: "var(--accent-gold)",
                top: -4,
                left: `${Math.max(0, Math.min(100, (rankIdx / 12) * 100))}%`,
                transform: "translateX(-50%)",
              }} />
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <button
              onClick={() => guess("lower")}
              disabled={loading}
              className="font-mono text-sm py-3 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ background: "var(--surface-2)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
            >
              ⬇ Lower
            </button>
            <button
              onClick={() => guess("higher")}
              disabled={loading}
              className="font-mono text-sm py-3 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ background: "var(--surface-2)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
            >
              ⬆ Higher
            </button>
          </div>
          {streak > 0 && (
            <button
              onClick={() => guess("cashout")}
              disabled={loading}
              className="w-full font-mono text-sm py-2.5 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
            >
              Cash Out — {multiplier}× = {Math.floor(bet * multiplier)} ◈
            </button>
          )}
          <p className="font-mono text-xs mt-2 text-center" style={{ color: "var(--text-secondary)" }}>
            Betting {bet} ◈
          </p>
        </div>
      )}

      {/* RESULT PHASE */}
      {phase === "result" && result && (
        <div className="text-center">
          <div className="p-8 rounded mb-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            {result.nextCard && (
              <div className="flex items-center justify-center gap-4 mb-4">
                {currentCard && <PlayingCard card={currentCard} dimmed />}
                <span style={{ color: "var(--text-secondary)", fontSize: 20 }}>→</span>
                <PlayingCard card={result.nextCard} highlight />
              </div>
            )}

            {result.outcome === "cashout" && (
              <>
                <p className="font-serif text-3xl mb-1" style={{ color: "var(--confidence-high)" }}>Cashed Out!</p>
                <p className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>
                  Streak: {result.streak} · {result.multiplier}× multiplier
                </p>
              </>
            )}
            {result.outcome === "lose" && (
              <>
                <p className="font-serif text-3xl mb-1" style={{ color: "var(--confidence-low)" }}>Wrong!</p>
                <p className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>
                  Streak of {result.streak} lost.
                </p>
              </>
            )}

            <p className="font-mono text-sm mt-2" style={{
              color: (result.creditsChange ?? 0) > 0 ? "var(--accent-gold)" : "var(--confidence-low)"
            }}>
              {(result.creditsChange ?? 0) > 0 ? "+" : ""}{result.creditsChange} ◈
            </p>

            {result.isBankrupt && (
              <p className="font-mono text-xs mt-3" style={{ color: "var(--accent-gold)" }}>
                The house always wins. Here's 25 ◈ to get back in the game.
              </p>
            )}
            <p className="font-mono text-xs mt-2" style={{ color: "var(--text-secondary)" }}>
              Balance: {result.newBalance?.toLocaleString()} ◈
            </p>
          </div>

          <div className="flex gap-3 justify-center">
            <button onClick={reset} className="font-mono text-sm px-5 py-2 rounded transition-opacity hover:opacity-90" style={{ background: "var(--accent-gold)", color: "var(--bg)" }}>
              Play Again
            </button>
            <Link href="/games" className="font-mono text-sm px-5 py-2 rounded" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
              Games Lobby
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
