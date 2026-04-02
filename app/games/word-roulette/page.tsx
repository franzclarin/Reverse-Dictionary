"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import WordLink from "@/components/WordLink";

type Phase = "bet" | "playing" | "result";

type GameState = {
  clue: string;
  token: string;
  guessesLeft: number;
};

type Result = {
  correct: boolean;
  word: string;
  creditsChange: number;
  newBalance: number;
  isBankrupt: boolean;
  multiplier?: number;
};

const BET_PRESETS = [25, 50, 100, 250];

export default function WordRoulettePage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(50);
  const [game, setGame] = useState<GameState | null>(null);
  const [guess, setGuess] = useState("");
  const [guessHistory, setGuessHistory] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!isSignedIn) {
    return (
      <main className="max-w-xl mx-auto px-6 py-12 text-center">
        <p className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>
          Sign in to play.
        </p>
        <Link href="/games" className="font-mono text-xs mt-4 inline-block" style={{ color: "var(--accent-gold)" }}>
          ← Back to Games
        </Link>
      </main>
    );
  }

  async function startGame() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/games/word-roulette", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", bet }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to start."); return; }
      setGame({ clue: data.clue, token: data.token, guessesLeft: 3 });
      setGuessHistory([]);
      setGuess("");
      setPhase("playing");
    } finally {
      setLoading(false);
    }
  }

  async function submitGuess() {
    if (!game || !guess.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/games/word-roulette", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "guess", guess: guess.trim(), token: game.token, bet }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }

      const newHistory = [...guessHistory, guess.trim()];
      setGuessHistory(newHistory);
      setGuess("");

      if (data.correct || data.gameOver) {
        setResult(data);
        setPhase("result");
      } else {
        setGame({ ...game, token: data.token, guessesLeft: data.guessesLeft });
      }
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setPhase("bet");
    setGame(null);
    setResult(null);
    setGuessHistory([]);
    setGuess("");
    setError("");
  }

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
            ← Games
          </Link>
          <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>
            Word Roulette
          </h1>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded font-mono text-xs" style={{ background: "#3a1a1a", color: "var(--confidence-low)", border: "1px solid #5a2a2a" }}>
          {error}
        </div>
      )}

      {/* BET PHASE */}
      {phase === "bet" && (
        <div>
          <p className="font-mono text-xs mb-6" style={{ color: "var(--text-secondary)" }}>
            Claude generates a cryptic clue for a random word. Guess within 3 tries.
          </p>
          <div
            className="p-5 rounded mb-6"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <p className="font-mono text-xs mb-3" style={{ color: "var(--text-secondary)" }}>
              PAYOUT TABLE
            </p>
            {[["Guess 1", "3×"], ["Guess 2", "2×"], ["Guess 3", "1.5×"], ["Miss all", "−bet"]].map(([g, p]) => (
              <div key={g} className="flex justify-between py-1">
                <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{g}</span>
                <span className="font-mono text-xs" style={{ color: "var(--accent-gold)" }}>{p}</span>
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
              type="number"
              min={10}
              max={500}
              value={bet}
              onChange={(e) => setBet(Number(e.target.value))}
              className="font-mono text-xs px-3 py-1.5 rounded w-24"
              style={{ background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
            />
          </div>
          <p className="font-mono text-xs mb-6" style={{ color: "var(--text-secondary)" }}>
            Min: 10 · Max: 500
          </p>

          <button
            onClick={startGame}
            disabled={loading || bet < 10 || bet > 500}
            className="font-mono text-sm px-6 py-2.5 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
          >
            {loading ? "Spinning..." : "SPIN →"}
          </button>
        </div>
      )}

      {/* PLAYING PHASE */}
      {phase === "playing" && game && (
        <div>
          <div
            className="p-6 rounded mb-6 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <p
              className="font-serif text-xl leading-relaxed"
              style={{ color: "var(--text-primary)", fontStyle: "italic" }}
            >
              "{game.clue}"
            </p>
          </div>

          <div className="flex gap-2 mb-4">
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className="w-2.5 h-2.5 rounded-full"
                style={{
                  background: n <= game.guessesLeft ? "var(--accent-gold)" : "var(--border)",
                }}
              />
            ))}
            <span className="font-mono text-xs ml-2" style={{ color: "var(--text-secondary)" }}>
              {game.guessesLeft} guess{game.guessesLeft !== 1 ? "es" : ""} remaining
            </span>
          </div>

          {guessHistory.length > 0 && (
            <div className="mb-3">
              {guessHistory.map((g, i) => (
                <p key={i} className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
                  ✗ {g}
                </p>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              autoFocus
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitGuess()}
              placeholder="Your guess..."
              className="font-mono text-sm px-3 py-2 rounded flex-1"
              style={{ background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
            />
            <button
              onClick={submitGuess}
              disabled={loading || !guess.trim()}
              className="font-mono text-xs px-4 py-2 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
            >
              {loading ? "..." : "Submit"}
            </button>
          </div>
          <p className="font-mono text-xs mt-2" style={{ color: "var(--text-secondary)" }}>
            Betting {bet} credits
          </p>
        </div>
      )}

      {/* RESULT PHASE */}
      {phase === "result" && result && (
        <div className="text-center">
          <div
            className="p-8 rounded mb-6"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            {result.correct ? (
              <>
                <p className="font-serif text-3xl mb-2" style={{ color: "var(--confidence-high)" }}>
                  Correct!
                </p>
                <p className="font-mono text-sm" style={{ color: "var(--accent-gold)" }}>
                  +{result.creditsChange} credits ({result.multiplier}× multiplier)
                </p>
              </>
            ) : (
              <>
                <p className="font-serif text-3xl mb-2" style={{ color: "var(--confidence-low)" }}>
                  Missed it.
                </p>
                <p className="font-mono text-sm mb-1" style={{ color: "var(--text-secondary)" }}>
                  The word was:
                </p>
                <p className="font-serif text-2xl" style={{ color: "var(--text-primary)" }}>
                  {result.word}
                </p>
                <p className="font-mono text-sm mt-2" style={{ color: "var(--confidence-low)" }}>
                  −{bet} credits
                </p>
              </>
            )}
            {result.isBankrupt && (
              <p className="font-mono text-xs mt-3" style={{ color: "var(--accent-gold)" }}>
                Bankrupt! Here's 25 free credits to get back in the game.
              </p>
            )}
            <p className="font-mono text-xs mt-3" style={{ color: "var(--text-secondary)" }}>
              Balance: {result.newBalance.toLocaleString()} ◈
            </p>
          </div>

          <div className="flex gap-3 justify-center flex-wrap">
            <button
              onClick={reset}
              className="font-mono text-sm px-5 py-2 rounded transition-opacity hover:opacity-90"
              style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
            >
              Play Again
            </button>
            <WordLink
              word={result.word}
              className="font-mono text-sm px-5 py-2 rounded"
              style={{ border: "1px solid var(--accent-gold)", color: "var(--accent-gold)" }}
            >
              View "{result.word}" →
            </WordLink>
            <Link
              href="/games"
              className="font-mono text-sm px-5 py-2 rounded"
              style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            >
              Games Lobby
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
