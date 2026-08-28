"use client";

import Link from "next/link";
import { useSound } from "@/context/SoundContext";

export default function Navbar() {
  const { enabled, toggle } = useSound();

  return (
    <header style={{ borderBottom: "1px solid var(--rd-border)", background: "var(--rd-paper)" }}>
      <nav className="max-w-6xl mx-auto px-6 h-16 flex items-center">
        {/* Logo mark */}
        <Link
          href="/"
          className="flex items-center gap-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ outlineColor: "var(--rd-accent)" }}
        >
          <span
            className="font-serif text-xl leading-none"
            style={{ color: "var(--rd-accent)" }}
            aria-hidden="true"
          >
            ¶
          </span>
          <span
            className="font-serif text-xl leading-none"
            style={{ color: "var(--rd-ink)" }}
          >
            Reverse Dictionary
          </span>
        </Link>

        {/* RD-18's explainer. The first nav link this bar has ever carried. */}
        <Link
          href="/explain"
          className="font-mono ml-auto mr-4 rounded px-1 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--rd-ink-muted)",
            outlineColor: "var(--rd-accent)",
          }}
        >
          How it works
        </Link>

        <button
          type="button"
          onClick={toggle}
          aria-pressed={enabled}
          aria-label={enabled ? "Mute sound effects" : "Unmute sound effects"}
          title={enabled ? "Sound on" : "Sound off"}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors hover:bg-[var(--rd-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ color: "var(--rd-ink-muted)", outlineColor: "var(--rd-accent)" }}
        >
          {enabled ? (
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 9v6h4l5 4V5L8 9H4z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <path
                d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 9v6h4l5 4V5L8 9H4z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <path
                d="M16 9l5 6M21 9l-5 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </nav>
    </header>
  );
}
