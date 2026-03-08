"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

type Phase = "bet" | "playing" | "result";

type Question = { definition: string; partOfSpeech: string; hint: string };

type GameState = {
  questions: Question[];
  token: string;
  count: number;
};

type AnswerResult = {
  word: string;
  guess: string;
  correct: boolean;
};

type Result = {
  results: AnswerResult[];
  correctCount: number;
  total: number;
  multiplier: number;
  creditsChange: number;
  newBalance: number;
  isBankrupt: boolean;
};

const BET_PRESETS = [25, 50, 100, 250];
const SECONDS_PER_QUESTION = 5;

const MULTIPLIER_LABELS: Record<number, string> = {
  5: "10/10 · 5×",
  3: "8–9/10 · 3×",
  2: "6–7/10 · 2×",
  1: "4–5/10 · 1× (break even)",
  0: "<4/10 · lose bet",
};

export default function SpeedRoundPage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(50);
  const [game, setGame] = useState<GameState | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [timeLeft, setTimeLeft] = useState(SECONDS_PER_QUESTION);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const advanceQuestion = useCallback(
    (finalAnswer: string, allAnswers: string[], game: GameState) => {
      const newAnswers = [...allAnswers, finalAnswer];
      const nextIdx = allAnswers.length; // index after adding

      if (nextIdx >= game.count) {
        // Submit all answers
        setSubmitting(true);
        fetch("/api/games/speed-round", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "submit", answers: newAnswers, token: game.token }),
        })
          .then((r) => r.json())
          .then((data) => {
            setResult(data);
            setPhase("result");
          })
          .catch(() => setError("Network error."))
          .finally(() => setSubmitting(false));
        return;
      }

      setAnswers(newAnswers);
      setCurrentIdx(nextIdx);
      setCurrentAnswer("");
      setTimeLeft(SECONDS_PER_QUESTION);
      inputRef.current?.focus();
    },
    []
  );

  useEffect(() => {
    if (phase !== "playing" || !game) return;
    if (timerRef.current) clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(timerRef.current!);
          // Capture current values via setState callback
          setCurrentAnswer((ans) => {
            setAnswers((prev) => {
              advanceQuestion(ans, prev, game);
              return prev;
            });
            return ans;
          });
          return 0;
        }
        return t - 1;
      });
    }, 1000);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase, currentIdx, game, advanceQuestion]);

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
      const res = await fetch("/api/games/speed-round", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", bet }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); return; }
      setGame(data);
      setCurrentIdx(0);
      setAnswers([]);
      setCurrentAnswer("");
      setTimeLeft(SECONDS_PER_QUESTION);
      setPhase("playing");
      setTimeout(() => inputRef.current?.focus(), 100);
    } finally {
      setLoading(false);
    }
  }

  function handleSkipOrSubmit() {
    if (!game || timerRef.current) clearInterval(timerRef.current!);
    setAnswers((prev) => {
      advanceQuestion(currentAnswer, prev, game!);
      return prev;
    });
    setCurrentAnswer("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSkipOrSubmit();
  }

  function reset() {
    setPhase("bet");
    setGame(null);
    setResult(null);
    setAnswers([]);
    setCurrentAnswer("");
    setError("");
  }

  const timerPct = (timeLeft / SECONDS_PER_QUESTION) * 100;
  const timerColor =
    timeLeft <= 2 ? "var(--confidence-low)" : timeLeft <= 3 ? "var(--confidence-mid)" : "var(--accent-gold)";

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <div className="mb-8">
        <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>← Games</Link>
        <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>Speed Round</h1>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded font-mono text-xs" style={{ background: "#3a1a1a", color: "var(--confidence-low)", border: "1px solid #5a2a2a" }}>
          {error}
        </div>
      )}

      {/* BET */}
      {phase === "bet" && (
        <div>
          <p className="font-mono text-xs mb-4" style={{ color: "var(--text-secondary)" }}>
            10 definitions flash by — 5 seconds each. Type the word or skip. Bet upfront.
          </p>
          <div className="p-4 rounded mb-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)" }}>SCORING</p>
            {Object.values(MULTIPLIER_LABELS).map((label) => (
              <p key={label} className="font-mono text-xs py-0.5" style={{ color: "var(--text-secondary)" }}>
                {label}
              </p>
            ))}
          </div>
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
            {loading ? "Loading..." : "START ⚡"}
          </button>
        </div>
      )}

      {/* PLAYING */}
      {phase === "playing" && game && !submitting && (
        <div>
          {/* Timer bar */}
          <div className="mb-6">
            <div className="flex justify-between mb-1">
              <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
                {currentIdx + 1} / {game.count}
              </p>
              <p className="font-mono text-xs font-bold" style={{ color: timerColor }}>
                {timeLeft.toFixed(0)}s
              </p>
            </div>
            <div className="h-1.5 rounded" style={{ background: "var(--border)" }}>
              <div
                className="h-1.5 rounded"
                style={{
                  width: `${timerPct}%`,
                  background: timerColor,
                  transition: "width 1s linear, background 0.3s",
                }}
              />
            </div>
          </div>

          {/* Definition */}
          <div className="p-6 rounded mb-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <p className="font-serif text-lg leading-relaxed mb-3" style={{ color: "var(--text-primary)", fontStyle: "italic" }}>
              "{game.questions[currentIdx].definition}"
            </p>
            <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
              {game.questions[currentIdx].partOfSpeech}
            </p>
          </div>

          {/* Input */}
          <div className="flex gap-2 mb-4">
            <input
              ref={inputRef}
              value={currentAnswer}
              onChange={(e) => setCurrentAnswer(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type the word..."
              className="font-mono text-sm px-3 py-2 rounded flex-1"
              style={{ background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
            />
            <button onClick={handleSkipOrSubmit}
              className="font-mono text-xs px-4 py-2 rounded"
              style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
              Skip →
            </button>
          </div>

          {/* Progress dots */}
          <div className="flex gap-1.5">
            {Array.from({ length: game.count }).map((_, i) => (
              <span key={i} className="w-2 h-2 rounded-full" style={{
                background: i < answers.length
                  ? "var(--confidence-high)"
                  : i === currentIdx
                    ? "var(--accent-gold)"
                    : "var(--border)",
              }} />
            ))}
          </div>
        </div>
      )}

      {submitting && (
        <div className="text-center py-12">
          <div className="dot-pulse justify-center inline-flex gap-1"><span/><span/><span/></div>
          <p className="font-mono text-xs mt-4" style={{ color: "var(--text-secondary)" }}>Scoring your round...</p>
        </div>
      )}

      {/* RESULT */}
      {phase === "result" && result && (
        <div>
          <div className="p-6 rounded mb-6 text-center" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <p className="font-serif text-3xl mb-1" style={{ color: result.multiplier > 0 ? "var(--confidence-high)" : "var(--confidence-low)" }}>
              {result.correctCount}/{result.total}
            </p>
            {result.multiplier > 0 ? (
              <p className="font-mono text-sm mb-2" style={{ color: "var(--accent-gold)" }}>
                {result.multiplier}× multiplier · +{result.creditsChange} credits
              </p>
            ) : (
              <p className="font-mono text-sm mb-2" style={{ color: "var(--confidence-low)" }}>
                −{bet} credits
              </p>
            )}
            {result.isBankrupt && (
              <p className="font-mono text-xs" style={{ color: "var(--accent-gold)" }}>
                Bankrupt! Here's 25 free credits to get back in the game.
              </p>
            )}
            <p className="font-mono text-xs mt-2" style={{ color: "var(--text-secondary)" }}>
              Balance: {result.newBalance.toLocaleString()} ◈
            </p>
          </div>

          {/* Answer breakdown */}
          <div className="mb-6" style={{ border: "1px solid var(--border)", borderRadius: "6px", overflow: "hidden" }}>
            {result.results.map((r, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-2"
                style={{ borderBottom: i < result.results.length - 1 ? "1px solid var(--border)" : undefined }}>
                <div className="flex items-center gap-3">
                  <span style={{ color: r.correct ? "var(--confidence-high)" : "var(--confidence-low)" }}>
                    {r.correct ? "✓" : "✗"}
                  </span>
                  <span className="font-mono text-xs" style={{ color: "var(--text-primary)" }}>{r.word}</span>
                </div>
                {!r.correct && r.guess && (
                  <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
                    you: {r.guess}
                  </span>
                )}
              </div>
            ))}
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
