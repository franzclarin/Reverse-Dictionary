"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SignInButton } from "@clerk/nextjs";
import SearchInput from "@/components/SearchInput";
import ResultListItem from "@/components/ResultListItem";
import { RateLimitInfo } from "@/types";

interface LookupResult {
  word: string;
  similarity: number;
}

interface SearchResultsProps {
  query: string;
}

const INITIAL_K = 10;
const LOAD_MORE_STEP = 10;

/** Animates 0 -> target over ~200ms; jumps straight to target under prefers-reduced-motion. */
function useCountUp(target: number, durationMs = 200) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reducedMotion || target === 0) {
      setValue(target);
      return;
    }

    let start: number | null = null;
    let frameId: number;

    const step = (timestamp: number) => {
      if (start === null) start = timestamp;
      const progress = Math.min((timestamp - start) / durationMs, 1);
      setValue(Math.round(progress * target));
      if (progress < 1) frameId = requestAnimationFrame(step);
    };

    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [target, durationMs]);

  return value;
}

export default function SearchResults({ query }: SearchResultsProps) {
  const router = useRouter();
  const [k, setK] = useState(INITIAL_K);
  const [results, setResults] = useState<LookupResult[]>([]);
  const [timingMs, setTimingMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);
  const requestIdRef = useRef(0);

  // A new query resets pagination — otherwise "load more" on one query would
  // carry over into a k of 30+ for the next.
  useEffect(() => {
    setK(INITIAL_K);
  }, [query]);

  useEffect(() => {
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const response = await fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, k }),
        });

        let data: Record<string, unknown> = {};
        try {
          data = await response.json();
        } catch {
          /* empty or non-JSON body */
        }

        // A newer query or "load more" click superseded this request.
        if (requestIdRef.current !== requestId) return;

        if (!response.ok) {
          if (response.status === 429) {
            setError((data.error as string) || "Rate limit exceeded");
            if (data.rateLimit) setRateLimit(data.rateLimit as RateLimitInfo);
          } else {
            const detail = data.detail ? ` — ${data.detail as string}` : "";
            throw new Error(
              `${(data.error as string) || "Search failed"} (HTTP ${response.status})${detail}`
            );
          }
          return;
        }

        setResults((data.results as LookupResult[]) ?? []);
        setTimingMs(typeof data.timingMs === "number" ? data.timingMs : null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "An unexpected error occurred");
      } finally {
        if (requestIdRef.current === requestId) setLoading(false);
      }
    })();
  }, [query, k]);

  const count = useCountUp(results.length);
  const canLoadMore = !loading && !error && results.length >= k;

  const handleSearch = (newQuery: string) => {
    router.push(`/search?q=${encodeURIComponent(newQuery)}`);
  };

  return (
    <main className="min-h-screen" style={{ background: "var(--gs-bg)" }}>
      <div
        className="sticky top-0 z-10 px-6 py-3"
        style={{ background: "var(--gs-bg)", borderBottom: "1px solid var(--gs-border)" }}
      >
        <div className="mx-auto max-w-[584px]">
          <SearchInput
            onSearch={handleSearch}
            isLoading={loading}
            variant="compact"
            initialValue={query}
          />
        </div>
      </div>

      <div className="mx-auto max-w-[584px] px-6 py-4">
        {query && !error && (
          <p
            className="font-google mb-2"
            style={{ fontSize: "13px", color: "var(--gs-text-muted)" }}
          >
            {loading && results.length === 0
              ? "Searching…"
              : `About ${count} result${count === 1 ? "" : "s"}${
                  timingMs !== null ? ` (${(timingMs / 1000).toFixed(2)} seconds)` : ""
                }`}
          </p>
        )}

        {rateLimit && (
          <div
            className="font-google mb-4 flex items-center justify-between gap-4 rounded px-4 py-3 text-sm"
            style={{ background: "var(--gs-hover-bg)", border: "1px solid var(--gs-border)" }}
          >
            <span style={{ color: "var(--gs-text-secondary)" }}>
              {rateLimit.remaining} of {rateLimit.limit} free lookups remaining today
            </span>
            <SignInButton mode="redirect">
              <button
                className="shrink-0 font-medium hover:underline"
                style={{ color: "var(--gs-accent)" }}
              >
                Sign in for 200/day →
              </button>
            </SignInButton>
          </div>
        )}

        {error && (
          <p className="font-google text-sm" style={{ color: "var(--gs-error)" }}>
            {error}
          </p>
        )}

        {!error && !query && (
          <p className="font-google text-sm" style={{ color: "var(--gs-text-muted)" }}>
            Type a description above to find a word.
          </p>
        )}

        {!error && query && !loading && results.length === 0 && (
          <p className="font-google text-sm" style={{ color: "var(--gs-text-muted)" }}>
            No results found for &ldquo;{query}&rdquo;
          </p>
        )}

        {results.length > 0 && (
          <ul className="list-none divide-y divide-[var(--gs-border)]">
            {results.map((r, i) => (
              <ResultListItem key={r.word} word={r.word} similarity={r.similarity} index={i} />
            ))}
          </ul>
        )}

        {canLoadMore && (
          <button
            type="button"
            onClick={() => setK((prev) => prev + LOAD_MORE_STEP)}
            className="font-google mt-4 text-sm hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ color: "var(--gs-accent)", outlineColor: "var(--gs-accent)" }}
          >
            Load more results
          </button>
        )}
      </div>
    </main>
  );
}
