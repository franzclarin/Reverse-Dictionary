"use client";

import { useState } from "react";
import { useSound } from "@/context/SoundContext";

interface WordShareButtonsProps {
  word: string;
  definition: string;
}

export default function WordShareButtons({
  word,
  definition,
}: WordShareButtonsProps) {
  const [copied, setCopied] = useState(false);
  const { play } = useSound();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    play("click");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleTwitter = () => {
    play("click");
    const url = window.location.href;
    const shortDef =
      definition.length > 100 ? definition.slice(0, 97) + "…" : definition;
    const tweetText = `TIL "${word}" — ${shortDef} ${url}`;
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const btnStyle = {
    color: "var(--rd-ink-secondary)",
    border: "1px solid var(--rd-border)",
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 px-3 py-2 font-sans text-sm rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{
          outlineColor: "var(--rd-accent)",
          ...(copied ? { color: "var(--rd-success)", border: "1px solid var(--rd-border)" } : btnStyle),
        }}
        onMouseEnter={(e) => {
          if (!copied) {
            e.currentTarget.style.borderColor = "var(--rd-accent)";
            e.currentTarget.style.color = "var(--rd-accent)";
          }
        }}
        onMouseLeave={(e) => {
          if (!copied) {
            e.currentTarget.style.borderColor = "var(--rd-border)";
            e.currentTarget.style.color = "var(--rd-ink-secondary)";
          }
        }}
      >
        {copied ? (
          "Copied!"
        ) : (
          <>
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
            Share ↗
          </>
        )}
      </button>

      <button
        onClick={handleTwitter}
        className="flex items-center gap-1.5 px-3 py-2 font-sans text-sm rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ ...btnStyle, outlineColor: "var(--rd-accent)" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--rd-accent)";
          e.currentTarget.style.color = "var(--rd-accent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--rd-border)";
          e.currentTarget.style.color = "var(--rd-ink-secondary)";
        }}
      >
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        X
      </button>
    </div>
  );
}
