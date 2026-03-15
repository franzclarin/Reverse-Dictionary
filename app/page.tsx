"use client";

import { useState } from "react";
import { useAuth, SignInButton } from "@clerk/nextjs";
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
        headers: { "Content-Type": "application/json" },
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
    <main className="max-w-3xl mx-auto px-6 py-20 flex flex-col items-center gap-10">
      {/* Hero */}
      <div className="text-center">
        <h1
          className="font-serif leading-tight mb-4"
          style={{
            fontSize: "clamp(2.5rem,6vw,4rem)",
            color: "var(--text-primary)",
          }}
        >
          Find the word you can&apos;t remember.
        </h1>
        <p
          className="font-light text-lg"
          style={{ color: "var(--text-secondary)" }}
        >
          Describe it. We&apos;ll find it.
        </p>
      </div>

      {/* Search bar */}
      <SearchInput onSearch={handleSearch} isLoading={isLoading} />

      {/* Loading dots */}
      {isLoading && (
        <div className="dot-pulse flex gap-2 items-center justify-center h-6">
          <span />
          <span />
          <span />
        </div>
      )}

      {/* Example chips — hidden while loading or after result */}
      {!isLoading && !result && !error && (
        <ExampleQueries onSelectExample={handleSearch} isLoading={isLoading} />
      )}

      {/* Guest rate limit banner */}
      {showGuestBanner && (
        <div
          className="w-full flex items-center justify-between gap-4 px-4 py-3 rounded-lg text-sm"
          style={{
            background: "var(--accent-gold-dim)",
            border: "1px solid rgba(201,168,76,0.2)",
          }}
        >
          <span className="font-mono" style={{ color: "var(--accent-gold)" }}>
            {rateLimit.remaining} of {rateLimit.limit} free lookups remaining
            today
          </span>
          <SignInButton mode="redirect">
            <button
              className="shrink-0 font-mono hover:underline font-medium"
              style={{ color: "var(--accent-gold)" }}
            >
              Sign in for 200/day →
            </button>
          </SignInButton>
        </div>
      )}

      {/* Results */}
      <ResultDisplay result={result} error={error} />
    </main>
  );
}
