"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

type Phase = "bet" | "playing" | "result";

type WordCard = { word: string; partOfSpeech: string };

type GameState = {
  words: [WordCard, WordCard];
  token: string;
};

type Result = {
  correct: boolean;
  higherIdx: number;
  scores: [number, number];
  words: [string, string];
  multiplier: number;
  creditsChange: number;
  newBalance: number;
  isBankrupt: boolean;
};

const BET_PRESETS = [25, 50, 100, 250];

export default function HigherLowerPage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(50);
  const [game, setGame] = useState<GameState | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [streak, setStreak] = useState(0);
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

  async function loadPair() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/games/higher-lower", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pair" }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      setGame({ words: data.words, token: data.token });
      setResult(null);
      setPhase("playing");
    } finally {
      setLoading(false);
    }
  }

  async function submitAnswer(choice: 0 | 1) {
    if (!game) return;
    setLoading(true);
    try {
      const res = await fetch("/api/games/higher-lower", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "answer", choice, token: game.token, bet, streak }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      setResult(data);
      if (data.correct) {
        setStreak((s) => s + 1);
      } else {
        setStreak(0);
      }
      setPhase("result");
    } finally {
      setLoading(false);
    }
  }

  function playAgain() {
    setPhase("bet");
    setGame(null);
    setResult(null);
    setError("");
  }

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>← Games</Link>
          <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>Higher or Lower</h1>
        </div>
        {streak > 0 && (
          <span className="font-mono text-sm" style={{ color: "var(--accent-gold)" }}>
            🔥 {streak} streak
          </span>
        )}
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
            Which word is MORE obscure? Correct = 1.5× (2× at 5+ streak). Wrong = lose bet.
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
          <button onClick={loadPair} disabled={loading || bet < 10 || bet > 500}
            className="font-mono text-sm px-6 py-2.5 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--accent-gold)", color: "var(--bg)" }}>
            {loading ? "Loading..." : "NEXT PAIR →"}
          </button>
        </div>
      )}

      {/* PLAYING */}
      {phase === "playing" && game && (
        <div>
          <p className="font-mono text-xs text-center mb-6" style={{ color: "var(--text-secondary)" }}>
            Which word is MORE obscure?
          </p>
          <div className="grid grid-cols-2 gap-4 mb-6">
            {game.words.map((w, i) => (
              <button key={i} onClick={() => submitAnswer(i as 0 | 1)} disabled={loading}
                className="p-6 rounded text-center transition-all hover:opacity-90"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", cursor: loading ? "wait" : "pointer" }}>
                <p className="font-serif text-xl mb-2" style={{ color: "var(--text-primary)" }}>"{w.word}"</p>
                <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{w.partOfSpeech}</p>
                <p className="font-mono text-xs mt-3" style={{ color: "var(--accent-gold)" }}>
                  {i === 0 ? "← LEFT" : "RIGHT →"}
                </p>
              </button>
            ))}
          </div>
          <p className="font-mono text-xs text-center" style={{ color: "var(--text-secondary)" }}>
            Bet: {bet} credits · Streak: {streak > 0 ? `🔥 ${streak}` : "0"}
          </p>
        </div>
      )}

      {/* RESULT */}
      {phase === "result" && result && game && (
        <div>
          <div className="p-6 rounded mb-6 text-center" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            {result.correct ? (
              <p className="font-serif text-3xl mb-3" style={{ color: "var(--confidence-high)" }}>Correct!</p>
            ) : (
              <p className="font-serif text-3xl mb-3" style={{ color: "var(--confidence-low)" }}>Wrong!</p>
            )}
            <div className="grid grid-cols-2 gap-4 mb-4">
              {game.words.map((w, i) => (
                <div key={i} className="p-3 rounded" style={{
                  background: "var(--surface-2)",
                  border: `1px solid ${i === result.higherIdx ? "var(--accent-gold)" : "var(--border)"}`,
                }}>
                  <p className="font-serif text-lg" style={{ color: "var(--text-primary)" }}>"{w.word}"</p>
                  <p className="font-mono text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
                    obscurity: {result.scores[i]}
                  </p>
                  {i === result.higherIdx && (
                    <p className="font-mono text-xs mt-1" style={{ color: "var(--accent-gold)" }}>← more obscure</p>
                  )}
                </div>
              ))}
            </div>
            <p className="font-mono text-sm" style={{ color: result.correct ? "var(--confidence-high)" : "var(--confidence-low)" }}>
              {result.creditsChange >= 0 ? "+" : ""}{result.creditsChange} credits
              {result.correct && result.multiplier === 2 && " (streak bonus!)"}
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

          <div className="flex gap-3 justify-center">
            <button onClick={result.correct ? loadPair : playAgain}
              className="font-mono text-sm px-5 py-2 rounded transition-opacity hover:opacity-90"
              style={{ background: "var(--accent-gold)", color: "var(--bg)" }}>
              {result.correct ? "Next Pair" : "Try Again"}
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
