"use client";

import { useState } from "react";

interface SaveWordButtonProps {
  word: string;
  initialSaved?: boolean;
}

export default function SaveWordButton({ word, initialSaved = false }: SaveWordButtonProps) {
  const [saved, setSaved] = useState(initialSaved);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    setLoading(true);
    try {
      const method = saved ? "DELETE" : "POST";
      const res = await fetch(`/api/word/${encodeURIComponent(word)}/save`, { method });
      if (res.ok) {
        setSaved(!saved);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
        saved
          ? "bg-blue-600 text-white hover:bg-blue-700"
          : "border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
      } disabled:opacity-50`}
    >
      <svg
        className="w-4 h-4"
        fill={saved ? "currentColor" : "none"}
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
      {saved ? "Saved" : "Save to collection"}
    </button>
  );
}
