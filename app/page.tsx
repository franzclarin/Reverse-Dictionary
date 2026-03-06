"use client";

import { useState } from "react";
import { useAuth, UserButton, SignInButton } from "@clerk/nextjs";
import Link from "next/link";
import SearchInput from "@/components/SearchInput";
import ResultDisplay from "@/components/ResultDisplay";
import ExampleQueries from "@/components/ExampleQueries";
import { ReverseDictionaryResponse, RateLimitInfo } from "@/types";

export default function Home() {
  const { isSignedIn } = useAuth();
  const [result, setResult] = useState<ReverseDictionaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);

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
        if (response.status === 429) {
          setError(data.error);
          if (data.rateLimit) setRateLimit(data.rateLimit);
        } else {
          throw new Error(data.error || "Failed to fetch word");
        }
        return;
      }

      if (data.rateLimit) setRateLimit(data.rateLimit);
      setResult(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const showGuestBanner =
    !isSignedIn && rateLimit !== null && rateLimit.isGuest;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 pb-20 gap-6">
      {/* Auth controls */}
      <div className="absolute top-4 right-4 flex items-center gap-3">
        {isSignedIn ? (
          <>
            <Link
              href="/collection"
              className="text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              My Words
            </Link>
            <UserButton afterSignOutUrl="/" />
          </>
        ) : (
          <SignInButton mode="redirect">
            <button className="text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
              Sign in
            </button>
          </SignInButton>
        )}
      </div>

      <main className="flex flex-col gap-8 items-center w-full">
        {/* Header */}
        <div className="text-center mb-4">
          <h1 className="text-6xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent mb-4">
            Reverse Dictionary
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl">
            Describe a concept in plain language, and discover the exact word
            you&apos;re looking for
          </p>
        </div>

        {/* Search Input */}
        <SearchInput onSearch={handleSearch} isLoading={isLoading} />

        {/* Example Queries */}
        <ExampleQueries onSelectExample={handleSearch} isLoading={isLoading} />

        {/* Guest nudge banner — shown after first lookup */}
        {showGuestBanner && (
          <div className="w-full max-w-2xl flex items-center justify-between gap-4 px-4 py-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-400">
            <span>
              {rateLimit.remaining} of {rateLimit.limit} free lookups remaining
              today
            </span>
            <SignInButton mode="redirect">
              <button className="shrink-0 text-blue-600 dark:text-blue-400 hover:underline font-medium">
                Sign in for 50/day &rarr;
              </button>
            </SignInButton>
          </div>
        )}

        {/* Results */}
        <ResultDisplay result={result} error={error} />
      </main>

      {/* Footer */}
      <footer className="mt-16 text-center text-sm text-gray-500 dark:text-gray-400">
        <p>Powered by Claude AI &bull; Built with Next.js</p>
      </footer>
    </div>
  );
}
