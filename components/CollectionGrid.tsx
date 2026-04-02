"use client";

import { useState } from "react";
import Link from "next/link";
import WordLink from "@/components/WordLink";

type SavedWordItem = {
  word: {
    id: string;
    word: string;
    partOfSpeech: string;
    definition: string;
  };
  savedAt: string;
};

export default function CollectionGrid({ words }: { words: SavedWordItem[] }) {
  const [items, setItems] = useState(words);

  const handleUnsave = async (wordSlug: string) => {
    const res = await fetch(`/api/word/${encodeURIComponent(wordSlug)}/save`, {
      method: "DELETE",
    });
    if (res.ok) {
      setItems((prev) => prev.filter((item) => item.word.word !== wordSlug));
    }
  };

  if (items.length === 0) {
    return (
      <div className="text-center py-24">
        <p
          className="font-serif text-2xl italic"
          style={{ color: "var(--text-secondary)" }}
        >
          Your collection is empty. Search for a word to begin.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block font-mono text-sm hover:underline"
          style={{ color: "var(--accent-gold)" }}
        >
          Start searching →
        </Link>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map(({ word, savedAt }) => (
        <div
          key={word.id}
          className="p-5 rounded-lg transition-all"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "rgba(201,168,76,0.4)";
            e.currentTarget.style.transform = "scale(1.01)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.transform = "scale(1)";
          }}
        >
          <WordLink word={word.word} className="block mb-4">
            <h2
              className="font-serif text-2xl mb-1.5"
              style={{ color: "var(--text-primary)" }}
            >
              {word.word}
            </h2>
            <span
              className="font-mono text-[10px] px-2 py-0.5 rounded"
              style={{
                background: "var(--accent-gold-dim)",
                color: "var(--accent-gold)",
              }}
            >
              {word.partOfSpeech}
            </span>
            <p
              className="mt-3 font-light text-sm leading-relaxed line-clamp-3"
              style={{ color: "var(--text-secondary)" }}
            >
              {word.definition}
            </p>
          </WordLink>

          <div
            className="flex items-center justify-between pt-3"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <p
              className="font-mono text-[10px]"
              style={{ color: "var(--text-secondary)" }}
            >
              {new Date(savedAt).toLocaleDateString()}
            </p>
            <button
              onClick={() => handleUnsave(word.word)}
              className="font-mono text-[10px] transition-colors"
              style={{ color: "var(--text-secondary)" }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.color = "var(--confidence-low)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = "var(--text-secondary)")
              }
            >
              Remove
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
