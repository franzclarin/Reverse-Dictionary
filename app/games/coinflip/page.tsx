"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

type Phase = "bet" | "flipping" | "result";

type Result = {
  result: "heads" | "tails";
  won: boolean;
  bet: number;
  creditsChange: number;
  newBalance: number;
  isBankrupt: boolean;
};

const BET_PRESETS = [10, 25, 50, 100];

const flipStyle = `
@keyframes coinFlip {
  0%   { transform: rotateY(0deg); }
  50%  { transform: rotateY(900deg); }
  100% { transform: rotateY(1800deg); }
}
@keyframes winPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(201,168,76,0); }
  50%       { box-shadow: 0 0 32px 8px rgba(201,168,76,0.35); }
}
@keyframes losePulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(224,82,82,0); }
  50%       { box-shadow: 0 0 32px 8px rgba(224,82,82,0.35); }
}
`;

export default function CoinFlipPage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(50);
  const [choice, setChoice] = useState<"heads" | "tails" | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isAllIn, setIsAllIn] = useState(false);

  if (!isSignedIn) {
    return (
      <main className="max-w-xl mx-auto px-6 py-12 text-center">
        <p className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>Sign in to play.</p>
        <Link href="/games" className="font-mono text-xs mt-4 inline-block" style={{ color: "var(--accent-gold)" }}>← Back to Games</Link>
      </main>
    );
  }

  async function flip(selectedChoice: "heads" | "tails") {
    setChoice(selectedChoice);
    setLoading(true);
    setError("");
    setPhase("flipping");
    try {
      const res = await fetch("/api/games/coinflip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice: selectedChoice, bet: isAllIn ? "allin" : bet }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); setPhase("bet"); return; }
      // Wait for flip animation
      setTimeout(() => {
        setResult(data);
        setPhase("result");
      }, 1050);
    } catch {
      setError("Network error."); setPhase("bet");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setPhase("bet");
    setResult(null);
    setChoice(null);
    setError("");
    setIsAllIn(false);
  }

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <style>{flipStyle}</style>

      <div className="mb-8">
        <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>← Games</Link>
        <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>Coin Flip</h1>
        <p className="font-mono text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>Double or nothing. Pure 50/50.</p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded font-mono text-xs" style={{ background: "#3a1a1a", color: "var(--confidence-low)", border: "1px solid #5a2a2a" }}>
          {error}
        </div>
      )}

      {/* BET PHASE */}
      {phase === "bet" && (
        <div>
          <div className="p-8 rounded mb-8 text-center" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div style={{
              width: 80, height: 80, borderRadius: "50%",
              background: "var(--accent-gold)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto",
              boxShadow: "0 4px 24px rgba(201,168,76,0.3)",
            }}>
              <span style={{ fontSize: 32, color: "var(--bg)", fontFamily: "DM Serif Display, serif" }}>◈</span>
            </div>
            <p className="font-mono text-xs mt-3" style={{ color: "var(--text-secondary)" }}>Payout: 2× bet</p>
          </div>

          <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)" }}>YOUR BET</p>
          <div className="flex gap-2 mb-4 flex-wrap">
            {BET_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => { setBet(p); setIsAllIn(false); }}
                className="font-mono text-xs px-3 py-1.5 rounded transition-all"
                style={{
                  background: bet === p && !isAllIn ? "var(--accent-gold)" : "var(--surface)",
                  color: bet === p && !isAllIn ? "var(--bg)" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}
              >
                {p}
              </button>
            ))}
            <button
              onClick={() => setIsAllIn(true)}
              className="font-mono text-xs px-3 py-1.5 rounded transition-all"
              style={{
                background: isAllIn ? "var(--confidence-low)" : "var(--surface)",
                color: isAllIn ? "#fff" : "var(--text-secondary)",
                border: `1px solid ${isAllIn ? "var(--confidence-low)" : "var(--border)"}`,
              }}
            >
              ALL IN
            </button>
            {!isAllIn && (
              <input
                type="number" min={10} max={500} value={bet}
                onChange={(e) => setBet(Number(e.target.value))}
                className="font-mono text-xs px-3 py-1.5 rounded w-24"
                style={{ background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
              />
            )}
          </div>
          {isAllIn && (
            <p className="font-mono text-xs mb-4" style={{ color: "var(--confidence-low)" }}>
              Betting your entire balance. Maximum chaos.
            </p>
          )}
          {!isAllIn && (
            <p className="font-mono text-xs mb-6" style={{ color: "var(--text-secondary)" }}>Min: 10 · Max: 500</p>
          )}

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 24 }}>
            <p className="font-mono text-xs mb-3" style={{ color: "var(--text-secondary)" }}>CHOOSE YOUR SIDE</p>
            <div className="flex gap-3">
              <button
                onClick={() => flip("heads")}
                disabled={loading || (!isAllIn && (bet < 10 || bet > 500))}
                className="flex-1 font-mono text-sm py-3 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
                style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
              >
                ◈ HEADS
              </button>
              <button
                onClick={() => flip("tails")}
                disabled={loading || (!isAllIn && (bet < 10 || bet > 500))}
                className="flex-1 font-mono text-sm py-3 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
                style={{ background: "var(--surface-2)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
              >
                TAILS ◈
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FLIPPING PHASE */}
      {phase === "flipping" && (
        <div className="text-center py-8">
          <div style={{
            width: 80, height: 80, borderRadius: "50%",
            background: "var(--accent-gold)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto",
            animation: "coinFlip 1s ease-in-out forwards",
          }}>
            <span style={{ fontSize: 32, color: "var(--bg)", fontFamily: "DM Serif Display, serif" }}>◈</span>
          </div>
          <p className="font-mono text-xs mt-4" style={{ color: "var(--text-secondary)" }}>Flipping…</p>
        </div>
      )}

      {/* RESULT PHASE */}
      {phase === "result" && result && (
        <div className="text-center">
          <div
            className="p-8 rounded mb-6"
            style={{
              background: "var(--surface)",
              border: `1px solid ${result.won ? "var(--accent-gold)" : "var(--confidence-low)"}`,
              animation: result.won ? "winPulse 1.5s ease-in-out 2" : "losePulse 1s ease-in-out 1",
            }}
          >
            <div style={{
              width: 80, height: 80, borderRadius: "50%",
              background: result.result === "heads" ? "var(--accent-gold)" : "var(--surface-2)",
              border: result.result === "tails" ? "2px solid var(--border)" : "none",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <span style={{
                fontSize: 32,
                color: result.result === "heads" ? "var(--bg)" : "var(--text-secondary)",
                fontFamily: "DM Serif Display, serif",
              }}>◈</span>
            </div>

            <p className="font-mono text-xs mb-1" style={{ color: "var(--text-secondary)" }}>
              {result.result.toUpperCase()}
              {result.result === choice ? " — your pick" : ""}
            </p>

            {result.won ? (
              <p className="font-serif text-3xl" style={{ color: "var(--confidence-high)" }}>You win!</p>
            ) : (
              <p className="font-serif text-3xl" style={{ color: "var(--confidence-low)" }}>You lose.</p>
            )}

            <p className="font-mono text-sm mt-2" style={{ color: result.won ? "var(--accent-gold)" : "var(--confidence-low)" }}>
              {result.won ? "+" : ""}{result.creditsChange} ◈
            </p>

            {result.isBankrupt && (
              <p className="font-mono text-xs mt-3" style={{ color: "var(--accent-gold)" }}>
                The house always wins. Here's 25 ◈ to get back in the game.
              </p>
            )}
            <p className="font-mono text-xs mt-2" style={{ color: "var(--text-secondary)" }}>
              Balance: {result.newBalance.toLocaleString()} ◈
            </p>
          </div>

          <div className="flex gap-3 justify-center">
            <button
              onClick={reset}
              className="font-mono text-sm px-5 py-2 rounded transition-opacity hover:opacity-90"
              style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
            >
              Flip Again
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
