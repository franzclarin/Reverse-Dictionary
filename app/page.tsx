"use client";

import { useState } from "react";
import SearchInput from "@/components/SearchInput";
import ResultDisplay from "@/components/ResultDisplay";
import ExampleQueries from "@/components/ExampleQueries";
import { ReverseDictionaryResponse } from "@/types";

export default function Home() {
  const [result, setResult] = useState<ReverseDictionaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = async (description: string) => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/reverse-dictionary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ description }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch word");
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 pb-20 gap-6">
      <main className="flex flex-col gap-8 items-center w-full">
        {/* Header */}
        <div className="text-center mb-4">
          <h1 className="text-6xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent mb-4">
            Reverse Dictionary
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl">
            Describe a concept in plain language, and discover the exact word you're looking for
          </p>
        </div>

        {/* Search Input */}
        <SearchInput onSearch={handleSearch} isLoading={isLoading} />

        {/* Example Queries */}
        <ExampleQueries onSelectExample={handleSearch} isLoading={isLoading} />

        {/* Results */}
        <ResultDisplay result={result} error={error} />
      </main>

      {/* Footer */}
      <footer className="mt-16 text-center text-sm text-gray-500 dark:text-gray-400">
        <p>Powered by Claude AI • Built with Next.js</p>
      </footer>
    </div>
  );
}
