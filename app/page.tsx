"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, SignInButton } from "@clerk/nextjs";
import SearchInput from "@/components/SearchInput";
import ExampleQueries from "@/components/ExampleQueries";
import { useLoading } from "@/context/LoadingContext";
import { RateLimitInfo } from "@/types";

export default function Home() {
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { startLoading, stopLoading, isLoading } = useLoading();
  const [error, setError] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);

  const handleSearch = async (description: string) => {
    startLoading();
    setError(null);
    let navigated = false;

    try {
      // Embedding-based lookup via the fine-tuned model. The Claude fallback
      // is disabled — errors are surfaced directly instead of being swallowed.
      const response = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: description, k: 5 }),
      });

      // Parse body safely — an empty body (e.g. a gateway 401/502) must not
      // throw "Unexpected end of JSON input" before we can check the status.
      let data: Record<string, unknown> = {};
      try {
        data = await response.json();
      } catch {
        /* empty or non-JSON body */
      }

      if (!response.ok) {
        if (response.status === 429) {
          setError((data.error as string) || "Rate limit exceeded");
          if (data.rateLimit) setRateLimit(data.rateLimit as typeof rateLimit);
        } else {
          const detail = data.detail ? ` — ${data.detail as string}` : "";
          throw new Error(
            `${(data.error as string) || "Failed to fetch word"} (HTTP ${response.status})${detail}`
          );
        }
        return;
      }

      const results = (data.results as { word: string; similarity: number }[]) ?? [];
      const top = results[0];
      if (!top) throw new Error("No results found");

      const alts: string[] = results.slice(1, 3).map((r) => r.word);
      const query = alts.length > 0 ? `?alternatives=${alts.join(",")}` : "";
      router.push(`/word/${encodeURIComponent(top.word)}${query}`);
      navigated = true;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred"
      );
    } finally {
      if (!navigated) stopLoading();
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

      {/* Example chips — hidden while loading */}
      {!isLoading && !error && (
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

      {/* Error */}
      {error && (
        <p className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>
          {error}
        </p>
      )}
    </main>
  );
}
