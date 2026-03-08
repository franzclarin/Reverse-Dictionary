"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";

type Phase = "bet" | "spinning" | "result";

type Reel = { word: string; domain: string; partOfSpeech: string };

type Result = {
  reels: Reel[];
  result: "triple" | "domain" | "pos" | "none";
  multiplier: number;
  creditsChange: number;
  newBalance: number;
  isBankrupt: boolean;
};

const BET_PRESETS = [10, 25, 50, 100];

const RESULT_LABELS = {
  triple: "JACKPOT — 3 matching words!",
  domain: "MATCH — same domain!",
  pos: "PAIR — same part of speech!",
  none: "No match. Better luck next spin.",
};

export default function LexicalSlotsPage() {
  const { isSignedIn } = useAuth();
  const [phase, setPhase] = useState<Phase>("bet");
  const [bet, setBet] = useState(25);
  const [result, setResult] = useState<Result | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [displayReels, setDisplayReels] = useState<Reel[] | null>(null);
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
    setSpinning(true);
    setError("");
    setDisplayReels(null);
    setPhase("spinning");

    try {
      const res = await fetch("/api/games/lexical-slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bet }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed."); setPhase("bet"); return; }

      // Animate reels revealing left-to-right
      setTimeout(() => setDisplayReels([data.reels[0]]), 600);
      setTimeout(() => setDisplayReels([data.reels[0], data.reels[1]]), 1000);
      setTimeout(() => {
        setDisplayReels(data.reels);
        setResult(data);
        setPhase("result");
        setSpinning(false);
      }, 1400);
    } catch {
      setError("Network error.");
      setPhase("bet");
      setSpinning(false);
    }
  }

  function reset() {
    setPhase("bet");
    setResult(null);
    setDisplayReels(null);
    setError("");
  }

  const win = result && result.result !== "none";

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <div className="mb-8">
        <Link href="/games" className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>← Games</Link>
        <h1 className="font-serif text-2xl mt-1" style={{ color: "var(--text-primary)" }}>Lexical Slots</h1>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded font-mono text-xs" style={{ background: "#3a1a1a", color: "var(--confidence-low)", border: "1px solid #5a2a2a" }}>
          {error}
        </div>
      )}

      {/* Reels */}
      <div
        className="p-6 rounded mb-6"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div className="flex gap-3 justify-center mb-4">
          {[0, 1, 2].map((i) => {
            const reel = displayReels?.[i];
            const isRevealed = !!reel;
            return (
              <div
                key={i}
                className="flex-1 h-20 rounded flex items-center justify-center text-center px-2"
                style={{
                  background: "var(--surface-2)",
                  border: `1px solid ${isRevealed ? "var(--accent-gold)" : "var(--border)"}`,
                  transition: "border-color 0.3s",
                  minWidth: 0,
                }}
              >
                {spinning && !isRevealed ? (
                  <div className="dot-pulse"><span/><span/><span/></div>
                ) : isRevealed ? (
                  <p className="font-mono text-xs break-words" style={{ color: "var(--text-primary)" }}>
                    {reel.word}
                  </p>
                ) : (
                  <p className="font-mono text-2xl" style={{ color: "var(--border)" }}>?</p>
                )}
              </div>
            );
          })}
        </div>

        {result && (
          <p
            className="text-center font-mono text-xs"
            style={{ color: win ? "var(--accent-gold)" : "var(--text-secondary)" }}
          >
            {RESULT_LABELS[result.result]}
          </p>
        )}

        {displayReels && displayReels.length === 3 && (
          <div className="mt-3 flex justify-center gap-4">
            {displayReels.map((r, i) => (
              <div key={i} className="text-center">
                <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{r.domain}</p>
                <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{r.partOfSpeech}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Paytable */}
      <div className="p-4 rounded mb-6" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)", letterSpacing: "0.1em" }}>PAYTABLE</p>
        {[["3 matching words", "10×"], ["Same domain (all 3)", "4×"], ["Same part of speech", "2×"], ["All different", "−bet"]].map(([label, pay]) => (
          <div key={label} className="flex justify-between py-0.5">
            <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{label}</span>
            <span className="font-mono text-xs" style={{ color: "var(--accent-gold)" }}>{pay}</span>
          </div>
        ))}
      </div>

      {/* Controls */}
      {(phase === "bet" || phase === "result") && (
        <div>
          {result && (
            <div className="mb-4 text-center">
              <p className="font-mono text-sm" style={{ color: win ? "var(--confidence-high)" : "var(--confidence-low)" }}>
                {result.creditsChange >= 0 ? "+" : ""}{result.creditsChange} credits
              </p>
              {result.isBankrupt && (
                <p className="font-mono text-xs mt-1" style={{ color: "var(--accent-gold)" }}>
                  Bankrupt! Here's 25 free credits to get back in the game.
                </p>
              )}
              <p className="font-mono text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
                Balance: {result.newBalance.toLocaleString()} ◈
              </p>
            </div>
          )}

          <p className="font-mono text-xs mb-2" style={{ color: "var(--text-secondary)" }}>BET</p>
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

          <div className="flex gap-3">
            <button onClick={phase === "result" ? reset : spin} disabled={spinning || bet < 10 || bet > 500}
              className="font-mono text-sm px-6 py-2.5 rounded transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ background: "var(--accent-gold)", color: "var(--bg)" }}>
              SPIN 🎰
            </button>
            {phase === "result" && (
              <Link href="/games" className="font-mono text-sm px-5 py-2 rounded" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                Games Lobby
              </Link>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
