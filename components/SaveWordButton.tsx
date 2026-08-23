"use client";

import { useState } from "react";

interface SaveWordButtonProps {
  word: string;
  initialSaved?: boolean;
}

export default function SaveWordButton({
  word,
  initialSaved = false,
}: SaveWordButtonProps) {
  const [saved, setSaved] = useState(initialSaved);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    setLoading(true);
    try {
      const method = saved ? "DELETE" : "POST";
      const res = await fetch(`/api/word/${encodeURIComponent(word)}/save`, {
        method,
      });
      if (res.ok) setSaved(!saved);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      className="flex items-center gap-1.5 px-4 py-2 font-google text-sm rounded transition-all disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{
        outlineColor: "var(--gs-accent)",
        ...(saved
          ? {
              background: "var(--gs-accent)",
              color: "#ffffff",
              border: "1px solid var(--gs-accent)",
            }
          : {
              background: "transparent",
              color: "var(--gs-accent)",
              border: "1px solid var(--gs-accent)",
            }),
      }}
    >
      {saved ? (
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
              strokeWidth={2.5}
              d="M5 13l4 4L19 7"
            />
          </svg>
          Saved
        </>
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
              d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
            />
          </svg>
          Save
        </>
      )}
    </button>
  );
}
