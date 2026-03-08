"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { SignInButton } from "@clerk/nextjs";

type LeaderboardEntry = {
  rank: number;
  name: string;
  credits: number;
  isYou: boolean;
};

const GAMES = [
  {
    slug: "word-roulette",
    emoji: "🎰",
    name: "Word Roulette",
    desc: "Guess the word from a cryptic clue",
  },
  {
    slug: "definition-bluff",
    emoji: "🃏",
    name: "Definition Bluff",
    desc: "Spot the real definition among fakes",
  },
  {
    slug: "lexical-slots",
    emoji: "🎰",
    name: "Lexical Slots",
    desc: "Spin for matching words",
  },
  {
    slug: "higher-lower",
    emoji: "📈",
    name: "Higher or Lower",
    desc: "Which word is more obscure?",
  },
  {
    slug: "speed-round",
    emoji: "⚡",
    name: "Speed Round",
    desc: "10 definitions, 5 seconds each",
  },
];

export default function GamesPage() {
  const { isSignedIn } = useAuth();
  const [credits, setCredits] = useState<number | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loadingLB, setLoadingLB] = useState(true);

  useEffect(() => {
    if (isSignedIn) {
      fetch("/api/credits")
        .then((r) => r.json())
        .then((d) => setCredits(d.credits ?? null))
        .catch(() => {});
    }
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((d) => setLeaderboard(d.leaderboard ?? []))
      .catch(() => {})
      .finally(() => setLoadingLB(false));
  }, [isSignedIn]);

  return (
    <main className="max-w-2xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="mb-10">
        <h1
          className="font-serif text-3xl mb-1"
          style={{ color: "var(--text-primary)" }}
        >
          Games
        </h1>
        {isSignedIn && credits !== null && (
          <p className="font-mono text-sm" style={{ color: "var(--accent-gold)" }}>
            ◈ {credits.toLocaleString()} credits
          </p>
        )}
        {!isSignedIn && (
          <p className="font-mono text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            Sign in to earn and spend credits.
          </p>
        )}
      </div>

      {/* Game list */}
      <div
        className="mb-10"
        style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}
      >
        {GAMES.map((game, i) => (
          <div
            key={game.slug}
            style={{
              borderBottom: i < GAMES.length - 1 ? "1px solid var(--border)" : undefined,
            }}
          >
            <div className="flex items-center justify-between py-4">
              <div>
                <p className="font-mono text-sm" style={{ color: "var(--text-primary)" }}>
                  {game.emoji} {game.name}
                </p>
                <p className="font-mono text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                  {game.desc}
                </p>
              </div>
              {isSignedIn ? (
                <Link
                  href={`/games/${game.slug}`}
                  className="font-mono text-xs px-3 py-1.5 rounded transition-opacity hover:opacity-80"
                  style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
                >
                  PLAY →
                </Link>
              ) : (
                <SignInButton mode="redirect">
                  <button
                    className="font-mono text-xs px-3 py-1.5 rounded"
                    style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                  >
                    Sign in
                  </button>
                </SignInButton>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* How to earn credits */}
      <div
        className="mb-10 p-4 rounded"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <p className="font-mono text-xs mb-3" style={{ color: "var(--accent-gold)" }}>
          HOW TO EARN CREDITS
        </p>
        {[
          ["Create an account", "+100"],
          ["First lookup of the day", "+10"],
          ["Daily streak bonus", "+5 × streak (cap 50)"],
          ["Save a word", "+2"],
          ["Share a word", "+3"],
        ].map(([reason, amount]) => (
          <div key={reason} className="flex justify-between py-1">
            <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
              {reason}
            </span>
            <span className="font-mono text-xs" style={{ color: "var(--accent-gold)" }}>
              {amount}
            </span>
          </div>
        ))}
      </div>

      {/* Leaderboard */}
      <div>
        <p
          className="font-mono text-xs mb-4"
          style={{ color: "var(--text-secondary)", letterSpacing: "0.1em" }}
        >
          LEADERBOARD
        </p>
        {loadingLB ? (
          <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
            Loading...
          </p>
        ) : leaderboard.length === 0 ? (
          <p className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
            No players yet. Be the first!
          </p>
        ) : (
          <div style={{ borderTop: "1px solid var(--border)" }}>
            {leaderboard.map((entry) => (
              <div
                key={entry.rank}
                className="flex items-center justify-between py-2"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="font-mono text-xs w-4"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {entry.rank}.
                  </span>
                  <span
                    className="font-mono text-xs"
                    style={{
                      color: entry.isYou
                        ? "var(--accent-gold)"
                        : "var(--text-primary)",
                    }}
                  >
                    {entry.name}
                    {entry.isYou && " (you)"}
                  </span>
                </div>
                <span
                  className="font-mono text-xs"
                  style={{ color: "var(--accent-gold)" }}
                >
                  {entry.credits.toLocaleString()} ◈
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
