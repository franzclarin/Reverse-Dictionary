"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import WordLink from "@/components/WordLink";

type Phase = "bet" | "playing" | "result";
type Option = { id: string; text: string };

type GameState = {
  word: string;
  options: Option[];
  token: string;
};

type Result = {
  correct: boolean;
  correctId: string;
  word: string;
  creditsChange: number;
  newBalance: number;
  isBankrupt: boolean;
};

const BET_PRESETS = [25, 50, 100, 250];
const TIMER_SECONDS = 30;

export default function DefinitionBluffPage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(50);
  const [game, setGame] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [timeLeft, setTimeLeft] = useState(TIMER_SECONDS);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (phase === "playing") {
      setTimeLeft(TIMER_SECONDS);
      timerRef.current = setInterval(() => {
        setTimeLeft((t) => {
          if (t <= 1) {
            clearInterval(timerRef.current!);
            // Auto-submit with null (timeout)
            submitAnswer("__timeout__");
            return 0;
          }
          return t - 1;
        });
      }, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  if (!isSignedIn) {
    return (
      <main className="max-w-xl mx-auto px-6 py-12 text-center">
        <p className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>Sign in to play.</p>
        <Link href="/games" className="font-mono text-xs mt-4 inline-block" style={{ color: "var(--accent-gold)" }}>← Back to Games</Link>
      </main>
    );
  }

  async function startGame() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/games/definition-bluff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", bet }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      setGame({ word: data.word, options: data.options, token: data.token });
      setSelected(null);
      setPhase("playing");
    } finally {
      setLoading(false);
    }
  }

  async function submitAnswer(id: string) {
    if (!game) return;
    if (timerRef.current) clearInterval(timerRef.current);
    setLoading(true);
    try {
      const res = await fetch("/api/games/definition-bluff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit", selectedId: id, token: game.token, bet }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      setResult(data);
      setPhase("result");
    } finally {
      setLoading(false);
    }
  }

  function handleSelect(id: string) {
    if (loading) return;
    setSelected(id);
    submitAnswer(id);
  }

  function reset() {
    setPhase("bet");
    setGame(null);
    setResult(null);
    setSelected(null);
    setError("");
  }

  const timerPct = (timeLeft / TIMER_SECONDS) * 100;
  const timerColor = timeLeft <= 5 ? "var(--confidence-low)" : timeLeft <= 10 ? "var(--confidence-mid)" : "var(--accent-gold)";

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>← Games</Link>
          <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>Definition Bluff</h1>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded font-mono text-xs" style={{ background: "#3a1a1a", color: "var(--confidence-low)", border: "1px solid #5a2a2a" }}>
          {error}
        </div>
      )}

      {/* BET */}
      {phase === "bet" && (
        <div>
          <p className="font-mono text-xs mb-6" style={{ color: "var(--text-secondary)" }}>
            One real definition. Three fakes. 30 seconds. Can you spot the truth?
            Correct = 2× bet. Wrong = lose bet.
          </p>
          <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)" }}>YOUR BET</p>
          <div className="flex gap-2 mb-4 flex-wrap">
            {BET_PRESETS.map((p) => (
              <button key={p} onClick={() => setBet(p)} className="font-mono text-xs px-3 py-1.5 rounded"
                style={{ background: bet === p ? "var(--accent-gold)" : "var(--surface)", color: bet === p ? "var(--bg)" : "var(--text-secondary)", border: "1px solid var(--border)" }}>
                {p}
              </button>
            ))}
            <input type="number" min={10} max={500} value={bet} onChange={(e) => setBet(Number(e.target.value))}
              className="font-mono text-xs px-3 py-1.5 rounded w-24"
              style={{ background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)" }} />
          </div>
          <button onClick={startGame} disabled={loading || bet < 10 || bet > 500}
            className="font-mono text-sm px-6 py-2.5 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--accent-gold)", color: "var(--bg)" }}>
            {loading ? "Shuffling..." : "DEAL →"}
          </button>
        </div>
      )}

      {/* PLAYING */}
      {phase === "playing" && game && (
        <div>
          {/* Timer */}
          <div className="mb-4">
            <div className="flex justify-between mb-1">
              <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
                What does <span style={{ color: "var(--text-primary)" }}>"{game.word}"</span> mean?
              </p>
              <p className="font-mono text-xs" style={{ color: timerColor }}>{timeLeft}s</p>
            </div>
            <div className="h-1 rounded" style={{ background: "var(--border)" }}>
              <div className="h-1 rounded transition-all duration-1000" style={{ width: `${timerPct}%`, background: timerColor }} />
            </div>
          </div>

          <div className="space-y-3 mb-4">
            {game.options.map((opt) => (
              <button key={opt.id} onClick={() => handleSelect(opt.id)} disabled={loading}
                className="w-full text-left p-4 rounded transition-all"
                style={{
                  background: selected === opt.id ? "var(--accent-gold-dim)" : "var(--surface)",
                  border: selected === opt.id ? "1px solid var(--accent-gold)" : "1px solid var(--border)",
                  cursor: loading ? "not-allowed" : "pointer",
                }}>
                <span className="font-mono text-xs mr-3" style={{ color: "var(--accent-gold)" }}>{opt.id}</span>
                <span className="font-mono text-xs" style={{ color: "var(--text-primary)" }}>{opt.text}</span>
              </button>
            ))}
          </div>
          <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>Bet: {bet} credits</p>
        </div>
      )}

      {/* RESULT */}
      {phase === "result" && result && game && (
        <div className="text-center">
          <div className="p-8 rounded mb-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            {result.correct ? (
              <p className="font-serif text-3xl mb-2" style={{ color: "var(--confidence-high)" }}>Correct!</p>
            ) : (
              <p className="font-serif text-3xl mb-2" style={{ color: "var(--confidence-low)" }}>Bluffed!</p>
            )}
            <p className="font-mono text-xs mb-3" style={{ color: "var(--text-secondary)" }}>
              The real definition of "{result.word}" was:
            </p>
            {/* Show the correct option */}
            {game.options.find((o) => o.id === result.correctId) && (
              <p className="font-mono text-xs p-3 rounded mb-3" style={{ background: "var(--surface-2)", color: "var(--text-primary)", border: "1px solid var(--confidence-high)" }}>
                <span style={{ color: "var(--accent-gold)" }}>{result.correctId}</span>{" "}
                {game.options.find((o) => o.id === result.correctId)!.text}
              </p>
            )}
            <p className="font-mono text-sm" style={{ color: result.correct ? "var(--confidence-high)" : "var(--confidence-low)" }}>
              {result.creditsChange >= 0 ? "+" : ""}{result.creditsChange} credits
            </p>
            {result.isBankrupt && (
              <p className="font-mono text-xs mt-2" style={{ color: "var(--accent-gold)" }}>
                Bankrupt! Here's 25 free credits to get back in the game.
              </p>
            )}
            <p className="font-mono text-xs mt-2" style={{ color: "var(--text-secondary)" }}>
              Balance: {result.newBalance.toLocaleString()} ◈
            </p>
          </div>
          <div className="flex gap-3 justify-center flex-wrap">
            <button onClick={reset} className="font-mono text-sm px-5 py-2 rounded transition-opacity hover:opacity-90" style={{ background: "var(--accent-gold)", color: "var(--bg)" }}>Play Again</button>
            <WordLink
              word={result.word}
              className="font-mono text-sm px-5 py-2 rounded"
              style={{ border: "1px solid var(--accent-gold)", color: "var(--accent-gold)" }}
            >
              View "{result.word}" →
            </WordLink>
            <Link href="/games" className="font-mono text-sm px-5 py-2 rounded" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>Games Lobby</Link>
          </div>
        </div>
      )}
    </main>
  );
}
