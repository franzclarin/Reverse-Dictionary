"use client";

import { useState } from "react";

interface WordShareButtonsProps {
  word: string;
  definition: string;
}

export default function WordShareButtons({
  word,
  definition,
}: WordShareButtonsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleTwitter = () => {
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
    color: "var(--text-secondary)",
    border: "1px solid var(--border)",
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 px-3 py-2 font-mono text-sm rounded transition-colors"
        style={copied ? { color: "var(--confidence-high)", border: "1px solid var(--border)" } : btnStyle}
        onMouseEnter={(e) => {
          if (!copied) {
            e.currentTarget.style.borderColor = "rgba(201,168,76,0.4)";
            e.currentTarget.style.color = "var(--accent-gold)";
          }
        }}
        onMouseLeave={(e) => {
          if (!copied) {
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.color = "var(--text-secondary)";
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
        className="flex items-center gap-1.5 px-3 py-2 font-mono text-sm rounded transition-colors"
        style={btnStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "rgba(201,168,76,0.4)";
          e.currentTarget.style.color = "var(--accent-gold)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--border)";
          e.currentTarget.style.color = "var(--text-secondary)";
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
