"use client";

import { useState } from "react";
import Link from "next/link";

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
      <div className="text-center py-16">
        <p className="text-gray-500 dark:text-gray-400 mb-4">
          No saved words yet. Search for a word and click{" "}
          <strong>Save to collection</strong>.
        </p>
        <Link
          href="/"
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          Start searching &rarr;
        </Link>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map(({ word, savedAt }) => (
        <div
          key={word.id}
          className="p-5 border border-gray-200 dark:border-gray-800 rounded-xl hover:border-blue-300 dark:hover:border-blue-700 transition-colors bg-white dark:bg-gray-900"
        >
          <Link href={`/word/${word.word}`} className="block">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-50 mb-1">
              {word.word}
            </h2>
            <p className="text-xs text-gray-400 italic mb-2">
              {word.partOfSpeech}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">
              {word.definition}
            </p>
          </Link>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-gray-400">
              Saved {new Date(savedAt).toLocaleDateString()}
            </p>
            <button
              onClick={() => handleUnsave(word.word)}
              className="text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
            >
              Remove
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
