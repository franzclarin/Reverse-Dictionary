"use client";

import { useState } from "react";

interface SearchInputProps {
  onSearch: (description: string) => void;
  isLoading: boolean;
}

export default function SearchInput({ onSearch, isLoading }: SearchInputProps) {
  const [description, setDescription] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (description.trim() && !isLoading) {
      onSearch(description.trim());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div
        className="flex items-center rounded-lg transition-colors"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
        }}
        onFocusCapture={(e) => {
          e.currentTarget.style.borderColor = "var(--accent-gold)";
        }}
        onBlurCapture={(e) => {
          e.currentTarget.style.borderColor = "var(--border)";
        }}
      >
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder='"the smell of rain on dry earth"'
          className="flex-1 bg-transparent px-5 py-4 text-base font-mono outline-none"
          style={{
            color: "var(--text-primary)",
          }}
          disabled={isLoading}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (description.trim() && !isLoading) {
                onSearch(description.trim());
              }
            }
          }}
        />
        <button
          type="submit"
          disabled={!description.trim() || isLoading}
          className="shrink-0 m-1.5 px-5 py-2.5 font-mono text-sm font-medium rounded transition-opacity hover:opacity-90 disabled:opacity-30"
          style={{
            background: "var(--accent-gold)",
            color: "var(--bg)",
          }}
        >
          →
        </button>
      </div>
    </form>
  );
}
