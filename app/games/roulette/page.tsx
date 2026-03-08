"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

type Phase = "bet" | "spinning" | "result";

type SpinResult = {
  result: number;
  color: "red" | "black" | "green";
  won: boolean;
  multiplier: number;
  creditsChange: number;
  newBalance: number;
  isBankrupt: boolean;
};

type BetType = "red" | "black" | "odd" | "even" | "low" | "high" | "dozen1" | "dozen2" | "dozen3" | "green" | "straight";

const BET_PRESETS = [10, 25, 50, 100];

const BET_OPTIONS: { type: BetType; label: string; payout: string }[] = [
  { type: "red", label: "Red", payout: "1:1" },
  { type: "black", label: "Black", payout: "1:1" },
  { type: "odd", label: "Odd", payout: "1:1" },
  { type: "even", label: "Even", payout: "1:1" },
  { type: "low", label: "1–18", payout: "1:1" },
  { type: "high", label: "19–36", payout: "1:1" },
  { type: "dozen1", label: "1st 12", payout: "2:1" },
  { type: "dozen2", label: "2nd 12", payout: "2:1" },
  { type: "dozen3", label: "3rd 12", payout: "2:1" },
  { type: "green", label: "Green (0)", payout: "14:1" },
  { type: "straight", label: "Straight Up", payout: "35:1" },
];

const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

const spinAnim = `
@keyframes wheelSpin {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(1440deg); }
}
@keyframes ballBounce {
  0%   { transform: translateX(0px); }
  20%  { transform: translateX(12px); }
  40%  { transform: translateX(-8px); }
  60%  { transform: translateX(6px); }
  80%  { transform: translateX(-4px); }
  100% { transform: translateX(0px); }
}
`;

function numberColor(n: number): string {
  if (n === 0) return "var(--confidence-high)";
  return RED_NUMBERS.has(n) ? "var(--confidence-low)" : "var(--text-secondary)";
}

export default function RoulettePage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(50);
  const [betType, setBetType] = useState<BetType>("red");
  const [straightUpNumber, setStraightUpNumber] = useState(7);
  const [result, setResult] = useState<SpinResult | null>(null);
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

  async function spin() {
    setLoading(true);
    setError("");
    setPhase("spinning");

    const body: Record<string, unknown> = { bet, betType };
    if (betType === "straight") body.straightUpNumber = straightUpNumber;

    try {
      const res = await fetch("/api/games/roulette", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); setPhase("bet"); setLoading(false); return; }

      setTimeout(() => {
        setResult(data);
        setPhase("result");
        setLoading(false);
      }, 2000);
    } catch {
      setError("Network error.");
      setPhase("bet");
      setLoading(false);
    }
  }

  function reset() {
    setPhase("bet");
    setResult(null);
    setError("");
  }

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <style>{spinAnim}</style>

      <div className="mb-8">
        <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>← Games</Link>
        <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>Roulette</h1>
        <p className="font-mono text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>European wheel — single zero.</p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded font-mono text-xs" style={{ background: "#3a1a1a", color: "var(--confidence-low)", border: "1px solid #5a2a2a" }}>
          {error}
        </div>
      )}

      {/* BET PHASE */}
      {phase === "bet" && (
        <div>
          {/* Bet type selector */}
          <p className="font-mono text-xs mb-3" style={{ color: "var(--text-secondary)" }}>PLACE YOUR BET</p>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {BET_OPTIONS.map((opt) => (
              <button
                key={opt.type}
                onClick={() => setBetType(opt.type)}
                className="font-mono text-xs px-2 py-2 rounded transition-all text-left"
                style={{
                  background: betType === opt.type ? "var(--accent-gold)" : "var(--surface)",
                  color: betType === opt.type ? "var(--bg)" : "var(--text-secondary)",
                  border: `1px solid ${betType === opt.type ? "var(--accent-gold)" : "var(--border)"}`,
                }}
              >
                <span style={{
                  display: "block",
                  color: betType === opt.type ? "var(--bg)" :
                    opt.type === "red" ? "var(--confidence-low)" :
                    opt.type === "green" ? "var(--confidence-high)" : undefined,
                  fontWeight: 600,
                }}>
                  {opt.label}
                </span>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{opt.payout}</span>
              </button>
            ))}
          </div>

          {/* Straight up number input */}
          {betType === "straight" && (
            <div className="mb-4">
              <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)" }}>NUMBER (0–36)</p>
              <div className="flex gap-2 items-center">
                <input
                  type="number" min={0} max={36} value={straightUpNumber}
                  onChange={(e) => setStraightUpNumber(Math.max(0, Math.min(36, parseInt(e.target.value) || 0)))}
                  className="font-mono text-sm px-3 py-2 rounded w-24"
                  style={{ background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
                />
                <span className="font-mono text-xs px-3 py-1 rounded" style={{
                  background: straightUpNumber === 0 ? "#1a3a1a" : RED_NUMBERS.has(straightUpNumber) ? "#3a1a1a" : "var(--surface-2)",
                  color: straightUpNumber === 0 ? "var(--confidence-high)" : RED_NUMBERS.has(straightUpNumber) ? "var(--confidence-low)" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                }}>
                  {straightUpNumber === 0 ? "Green" : RED_NUMBERS.has(straightUpNumber) ? "Red" : "Black"}
                </span>
              </div>
            </div>
          )}

          {/* Bet amount */}
          <p className="font-mono text-xs mb-2 mt-4" style={{ color: "var(--text-secondary)" }}>YOUR BET</p>
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
            onClick={spin}
            disabled={loading || bet < 10 || bet > 500}
            className="font-mono text-sm px-6 py-2.5 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
          >
            SPIN 🎡
          </button>
        </div>
      )}

      {/* SPINNING PHASE */}
      {phase === "spinning" && (
        <div className="text-center py-8">
          <div style={{
            width: 120, height: 120, borderRadius: "50%",
            border: "4px solid var(--accent-gold)",
            background: "var(--surface)",
            margin: "0 auto",
            animation: "wheelSpin 2s cubic-bezier(0.17,0.67,0.12,0.99) forwards",
            display: "flex", alignItems: "center", justifyContent: "center",
            position: "relative",
            overflow: "hidden",
          }}>
            {/* Simple wheel segments */}
            {[0,1,2,3,4,5,6].map(i => (
              <div key={i} style={{
                position: "absolute",
                width: 2,
                height: "100%",
                background: i % 2 === 0 ? "var(--confidence-low)" : "var(--surface-2)",
                transform: `rotate(${i * 25}deg)`,
              }} />
            ))}
            <div style={{
              position: "relative", zIndex: 1,
              width: 40, height: 40, borderRadius: "50%",
              background: "var(--bg)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ color: "var(--accent-gold)", fontSize: 14, fontFamily: "monospace" }}>?</span>
            </div>
          </div>
          <div style={{ animation: "ballBounce 0.4s ease-in-out 3", display: "inline-block", marginTop: 16 }}>
            <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>The ball is rolling…</p>
          </div>
        </div>
      )}

      {/* RESULT PHASE */}
      {phase === "result" && result && (
        <div className="text-center">
          <div className="p-8 rounded mb-6" style={{ background: "var(--surface)", border: `1px solid ${result.won ? "var(--accent-gold)" : "var(--confidence-low)"}` }}>
            {/* Winning number */}
            <div style={{
              width: 80, height: 80, borderRadius: "50%",
              background: result.color === "red" ? "#3a1a1a" : result.color === "green" ? "#1a3a1a" : "var(--surface-2)",
              border: `3px solid ${result.color === "red" ? "var(--confidence-low)" : result.color === "green" ? "var(--confidence-high)" : "var(--border)"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <span className="font-serif text-3xl" style={{ color: numberColor(result.result) }}>
                {result.result}
              </span>
            </div>

            <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)" }}>
              {result.result} {result.color.toUpperCase()}
              {result.result > 0 ? ` · ${result.result % 2 === 0 ? "Even" : "Odd"} · ${result.result <= 18 ? "Low" : "High"}` : ""}
            </p>

            {result.won ? (
              <>
                <p className="font-serif text-3xl" style={{ color: "var(--confidence-high)" }}>Winner!</p>
                <p className="font-mono text-sm mt-1" style={{ color: "var(--accent-gold)" }}>
                  +{result.creditsChange} ◈ ({result.multiplier}:1)
                </p>
              </>
            ) : (
              <>
                <p className="font-serif text-3xl" style={{ color: "var(--confidence-low)" }}>Missed.</p>
                <p className="font-mono text-sm mt-1" style={{ color: "var(--confidence-low)" }}>
                  −{bet} ◈
                </p>
              </>
            )}

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
            <button onClick={reset} className="font-mono text-sm px-5 py-2 rounded transition-opacity hover:opacity-90" style={{ background: "var(--accent-gold)", color: "var(--bg)" }}>
              Spin Again
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
