"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

type Phase = "bet" | "rolling" | "point" | "result";

type RollData = {
  dice: [number, number];
  sum: number;
  phase: string;
  outcome?: "win" | "lose";
  point?: number;
  token?: string;
  creditsChange?: number;
  newBalance?: number;
  isBankrupt?: boolean;
};

const BET_PRESETS = [25, 50, 100, 250];

const DIE_DOTS: Record<number, number[][]> = {
  1: [[1,1]],
  2: [[0,0],[2,2]],
  3: [[0,0],[1,1],[2,2]],
  4: [[0,0],[0,2],[2,0],[2,2]],
  5: [[0,0],[0,2],[1,1],[2,0],[2,2]],
  6: [[0,0],[0,2],[1,0],[1,2],[2,0],[2,2]],
};

const diceAnim = `
@keyframes diceRoll {
  0%   { transform: rotateX(0deg) rotateY(0deg); }
  25%  { transform: rotateX(180deg) rotateY(90deg); }
  50%  { transform: rotateX(360deg) rotateY(180deg); }
  75%  { transform: rotateX(270deg) rotateY(270deg); }
  100% { transform: rotateX(360deg) rotateY(360deg); }
}
`;

function Die({ value, rolling }: { value: number; rolling: boolean }) {
  const dots = DIE_DOTS[value] ?? DIE_DOTS[1];
  return (
    <div style={{
      width: 64, height: 64,
      background: "var(--surface-2)",
      border: "2px solid var(--border)",
      borderRadius: 10,
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)",
      gridTemplateRows: "repeat(3, 1fr)",
      padding: 8,
      animation: rolling ? "diceRoll 0.7s ease-out" : "none",
    }}>
      {Array.from({ length: 9 }, (_, i) => {
        const row = Math.floor(i / 3);
        const col = i % 3;
        const hasDot = dots.some(([r, c]) => r === row && c === col);
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            {hasDot && (
              <div style={{
                width: 10, height: 10, borderRadius: "50%",
                background: "var(--accent-gold)",
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function DicePage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(50);
  const [rolling, setRolling] = useState(false);
  const [currentDice, setCurrentDice] = useState<[number, number]>([1, 1]);
  const [point, setPoint] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [rollHistory, setRollHistory] = useState<{ dice: [number, number]; sum: number }[]>([]);
  const [result, setResult] = useState<RollData | null>(null);
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

  async function roll(action: "comeout" | "roll", currentToken?: string) {
    setLoading(true);
    setRolling(true);
    setError("");

    const body = action === "comeout"
      ? { action: "comeout", bet }
      : { action: "roll", token: currentToken };

    try {
      const res = await fetch("/api/games/dice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as RollData & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Failed.");
        setRolling(false);
        setLoading(false);
        return;
      }

      setTimeout(() => {
        setRolling(false);
        setCurrentDice(data.dice);

        setRollHistory(prev => [...prev, { dice: data.dice, sum: data.sum }]);

        if (data.phase === "resolved") {
          setResult(data);
          setPhase("result");
        } else if (data.phase === "point") {
          setPoint(data.point ?? null);
          setToken(data.token ?? null);
          setPhase("point");
        }
        setLoading(false);
      }, 750);
    } catch {
      setError("Network error.");
      setRolling(false);
      setLoading(false);
    }
  }

  function reset() {
    setPhase("bet");
    setResult(null);
    setPoint(null);
    setToken(null);
    setRollHistory([]);
    setCurrentDice([1, 1]);
    setError("");
  }

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <style>{diceAnim}</style>

      <div className="mb-8">
        <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>← Games</Link>
        <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>Dice — Craps Lite</h1>
        <p className="font-mono text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>Pass line only. The purest dice game.</p>
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
            <p className="font-mono text-xs mb-3" style={{ color: "var(--accent-gold)" }}>COME-OUT ROLL</p>
            {[
              ["7 or 11", "Win instantly", "var(--confidence-high)"],
              ["2, 3, or 12", "Lose instantly", "var(--confidence-low)"],
              ["Any other", "Sets the point", "var(--text-secondary)"],
            ].map(([roll, result, color]) => (
              <div key={roll} className="flex justify-between py-1">
                <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{roll}</span>
                <span className="font-mono text-xs" style={{ color }}>{result}</span>
              </div>
            ))}
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12 }}>
              <p className="font-mono text-xs mb-2" style={{ color: "var(--accent-gold)" }}>POINT PHASE</p>
              {[
                ["Roll the point again", "Win (1× bet)", "var(--confidence-high)"],
                ["Roll a 7", "Lose", "var(--confidence-low)"],
              ].map(([roll, result, color]) => (
                <div key={roll} className="flex justify-between py-1">
                  <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{roll}</span>
                  <span className="font-mono text-xs" style={{ color }}>{result}</span>
                </div>
              ))}
            </div>
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
            onClick={() => { setRollHistory([]); roll("comeout"); }}
            disabled={loading || bet < 10 || bet > 500}
            className="font-mono text-sm px-6 py-2.5 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
          >
            ROLL 🎲
          </button>
        </div>
      )}

      {/* POINT PHASE */}
      {(phase === "point" || (phase === "bet" && rolling)) && (
        <div>
          <div className="text-center p-8 rounded mb-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex gap-4 justify-center mb-4">
              <Die value={currentDice[0]} rolling={rolling} />
              <Die value={currentDice[1]} rolling={rolling} />
            </div>
            {!rolling && (
              <p className="font-serif text-3xl" style={{ color: "var(--text-primary)" }}>
                {currentDice[0]} + {currentDice[1]} = {currentDice[0] + currentDice[1]}
              </p>
            )}
          </div>

          {point && (
            <div className="p-4 rounded mb-4 text-center" style={{ background: "var(--surface-2)", border: "1px solid var(--accent-gold)" }}>
              <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>POINT</p>
              <p className="font-serif text-4xl" style={{ color: "var(--accent-gold)" }}>{point}</p>
              <p className="font-mono text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
                Roll {point} again before rolling 7
              </p>
            </div>
          )}

          {rollHistory.length > 1 && (
            <div className="mb-4">
              <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)" }}>ROLL HISTORY</p>
              <div className="flex gap-2 flex-wrap">
                {rollHistory.slice(0, -1).map((r, i) => (
                  <span key={i} className="font-mono text-xs px-2 py-0.5 rounded" style={{ background: "var(--surface-2)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>
                    {r.sum}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => roll("roll", token ?? undefined)}
            disabled={loading || rolling}
            className="w-full font-mono text-sm py-3 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
          >
            {rolling ? "Rolling…" : "ROLL AGAIN 🎲"}
          </button>
          <p className="font-mono text-xs mt-2 text-center" style={{ color: "var(--text-secondary)" }}>
            Betting {bet} ◈
          </p>
        </div>
      )}

      {/* RESULT PHASE */}
      {phase === "result" && result && (
        <div className="text-center">
          <div className="p-8 rounded mb-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex gap-4 justify-center mb-4">
              <Die value={result.dice[0]} rolling={false} />
              <Die value={result.dice[1]} rolling={false} />
            </div>
            <p className="font-serif text-2xl mb-2" style={{ color: "var(--text-primary)" }}>
              {result.dice[0]} + {result.dice[1]} = {result.sum}
            </p>

            {result.outcome === "win" ? (
              <p className="font-serif text-3xl mt-2" style={{ color: "var(--confidence-high)" }}>Winner!</p>
            ) : (
              <p className="font-serif text-3xl mt-2" style={{ color: "var(--confidence-low)" }}>Seven out.</p>
            )}

            <p className="font-mono text-sm mt-2" style={{ color: result.outcome === "win" ? "var(--accent-gold)" : "var(--confidence-low)" }}>
              {result.outcome === "win" ? "+" : ""}{result.creditsChange} ◈
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
              Roll Again
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
