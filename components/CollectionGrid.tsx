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
        <p className="font-sans text-lg" style={{ color: "var(--rd-ink-muted)" }}>
          Your collection is empty. Search for a word to begin.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block font-mono text-xs uppercase tracking-wide hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ color: "var(--rd-accent)", outlineColor: "var(--rd-accent)" }}
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
          className="p-5 rounded-lg transition-colors"
          style={{ background: "#ffffff", border: "1px solid var(--rd-border)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--rd-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#ffffff";
          }}
        >
          <WordLink word={word.word} className="block mb-4">
            <h2
              className="font-serif text-2xl mb-1.5"
              style={{ color: "var(--rd-accent)" }}
            >
              {word.word}
            </h2>
            <span
              className="font-mono text-[10px] uppercase tracking-wide px-2 py-0.5 rounded"
              style={{ background: "var(--rd-hover)", color: "var(--rd-ink-muted)" }}
            >
              {word.partOfSpeech}
            </span>
            <p
              className="mt-3 font-sans text-sm leading-relaxed line-clamp-3"
              style={{ color: "var(--rd-ink-gloss)" }}
            >
              {word.definition}
            </p>
          </WordLink>

          <div
            className="flex items-center justify-between pt-3"
            style={{ borderTop: "1px solid var(--rd-border)" }}
          >
            <p className="font-mono text-[10px]" style={{ color: "var(--rd-ink-muted)" }}>
              {new Date(savedAt).toLocaleDateString()}
            </p>
            <button
              onClick={() => handleUnsave(word.word)}
              className="font-mono text-[10px] uppercase tracking-wide transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ color: "var(--rd-ink-muted)", outlineColor: "var(--rd-accent)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--rd-error)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--rd-ink-muted)")}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
