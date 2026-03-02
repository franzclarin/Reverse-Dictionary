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
    <form onSubmit={handleSubmit} className="w-full max-w-3xl">
      <div className="flex flex-col gap-4">
        <div className="relative">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe a concept... (e.g., 'the smell of rain on dry earth')"
            className="w-full px-6 py-4 text-lg border-2 border-gray-300 rounded-2xl focus:border-blue-500 focus:outline-none resize-none transition-colors dark:bg-gray-800 dark:border-gray-600 dark:text-white"
            rows={3}
            disabled={isLoading}
          />
        </div>
        <button
          type="submit"
          disabled={!description.trim() || isLoading}
          className="px-8 py-4 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors text-lg"
        >
          {isLoading ? "Searching..." : "Find Word"}
        </button>
      </div>
    </form>
  );
}
