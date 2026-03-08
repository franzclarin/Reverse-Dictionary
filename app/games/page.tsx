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
    slug: "blackjack",
    emoji: "🃏",
    name: "Blackjack",
    desc: "Beat the dealer. BJ pays 3:2.",
    section: "casino",
  },
  {
    slug: "dice",
    emoji: "🎲",
    name: "Dice — Craps Lite",
    desc: "Pass line only. Roll your point.",
    section: "casino",
  },
  {
    slug: "roulette",
    emoji: "🎡",
    name: "Roulette",
    desc: "European wheel. Single zero.",
    section: "casino",
  },
  {
    slug: "hilo",
    emoji: "🃏",
    name: "Hi-Lo",
    desc: "Higher or lower? Build a streak.",
    section: "casino",
  },
  {
    slug: "coinflip",
    emoji: "🪙",
    name: "Coin Flip",
    desc: "Double or nothing. 50/50.",
    section: "casino",
  },
  {
    slug: "word-roulette",
    emoji: "🎰",
    name: "Word Roulette",
    desc: "Guess the word from a cryptic clue",
    section: "lexical",
  },
  {
    slug: "definition-bluff",
    emoji: "📖",
    name: "Definition Bluff",
    desc: "Spot the real definition among fakes",
    section: "lexical",
  },
  {
    slug: "lexical-slots",
    emoji: "🎰",
    name: "Lexical Slots",
    desc: "Spin for matching words",
    section: "lexical",
  },
  {
    slug: "higher-lower",
    emoji: "📈",
    name: "Higher or Lower",
    desc: "Which word is more obscure?",
    section: "lexical",
  },
  {
    slug: "speed-round",
    emoji: "⚡",
    name: "Speed Round",
    desc: "10 definitions, 5 seconds each",
    section: "lexical",
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
      <div className="mb-10">
        {/* Casino games */}
        <p className="font-mono text-xs mb-3" style={{ color: "var(--accent-gold)", letterSpacing: "0.1em" }}>
          CASINO
        </p>
        <div style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", marginBottom: 24 }}>
          {GAMES.filter(g => g.section === "casino").map((game, i, arr) => (
            <div key={game.slug} style={{ borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : undefined }}>
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
                    <button className="font-mono text-xs px-3 py-1.5 rounded" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                      Sign in
                    </button>
                  </SignInButton>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Lexical games */}
        <p className="font-mono text-xs mb-3" style={{ color: "var(--accent-gold)", letterSpacing: "0.1em" }}>
          LEXICAL
        </p>
        <div style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
          {GAMES.filter(g => g.section === "lexical").map((game, i, arr) => (
            <div key={game.slug} style={{ borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : undefined }}>
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
                    <button className="font-mono text-xs px-3 py-1.5 rounded" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                      Sign in
                    </button>
                  </SignInButton>
                )}
              </div>
            </div>
          ))}
        </div>
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
