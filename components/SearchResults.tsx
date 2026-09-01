"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SearchInput from "@/components/SearchInput";
import ResultListItem from "@/components/ResultListItem";
import { useSound } from "@/context/SoundContext";

interface LookupResult {
  word: string;
  similarity: number;
}

interface SearchResultsProps {
  query: string;
}

const INITIAL_K = 10;
const LOAD_MORE_STEP = 10;

/** Counts up to the number, or jumps to it for viewers who want less motion. */
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
  const requestIdRef = useRef(0);
  const { play } = useSound();
  // Names this search, not this request. React runs the effect below twice in
  // development on purpose, to catch effects that are unsafe to repeat; both
  // runs read the same id from here, so the server records one search rather
  // than two. Asking for more results, or asking again, is a different search
  // and gets a different id.
  const searchId = useMemo(
    () => (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, k]
  );
  // Held this way so muting mid-search doesn't restart the search.
  const playRef = useRef(play);
  playRef.current = play;

  useEffect(() => {
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    // Cancels the request if this effect runs again or the page is left, so an
    // abandoned search stops costing the server a lookup.
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const response = await fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, k, searchId }),
          signal: controller.signal,
        });

        let data: Record<string, unknown> = {};
        try {
          data = await response.json();
        } catch {
          /* empty or non-JSON body */
        }

        // A newer request has already replaced this one.
        if (requestIdRef.current !== requestId) return;

        if (!response.ok) {
          const detail = data.detail ? ` — ${data.detail as string}` : "";
          throw new Error(
            `${(data.error as string) || "Search failed"} (HTTP ${response.status})${detail}`
          );
        }

        const newResults = (data.results as LookupResult[]) ?? [];
        setResults(newResults);
        setTimingMs(typeof data.timingMs === "number" ? data.timingMs : null);
        playRef.current(newResults.length > 0 ? "stamp" : "error");
      } catch (err) {
        // We cancelled it ourselves — say nothing, and leave the spinner to
        // whichever search replaced this one.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "An unexpected error occurred");
        playRef.current("error");
      } finally {
        if (!controller.signal.aborted && requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [query, k, searchId]);

  const count = useCountUp(results.length);
  const canLoadMore = !loading && !error && results.length >= k;

  const handleSearch = (newQuery: string) => {
    router.push(`/search?q=${encodeURIComponent(newQuery)}`);
  };

  return (
    <main className="min-h-screen" style={{ background: "var(--rd-paper)" }}>
      <div
        className="sticky top-0 z-10 px-6 py-3"
        style={{ background: "var(--rd-paper)", borderBottom: "1px solid var(--rd-border)" }}
      >
        <div className="mx-auto max-w-[640px]">
          <SearchInput
            onSearch={handleSearch}
            isLoading={loading}
            variant="compact"
            initialValue={query}
          />
        </div>
      </div>

      <div className="mx-auto max-w-[640px] px-6 py-5">
        {query && !error && (
          <p
            className="font-mono mb-3 uppercase tracking-wide"
            style={{ fontSize: "11px", color: "var(--rd-ink-muted)" }}
          >
            {loading && results.length === 0
              ? "Searching…"
              : `${count} ${count === 1 ? "entry" : "entries"}${
                  timingMs !== null ? ` · ${(timingMs / 1000).toFixed(2)}s` : ""
                }`}
          </p>
        )}

        {error && (
          <p className="font-sans text-sm" style={{ color: "var(--rd-error)" }}>
            {error}
          </p>
        )}

        {!error && !query && (
          <p className="font-sans text-sm" style={{ color: "var(--rd-ink-muted)" }}>
            Type a description above to find a word.
          </p>
        )}

        {!error && query && !loading && results.length === 0 && (
          <p className="font-sans text-sm" style={{ color: "var(--rd-ink-muted)" }}>
            No entries found for &ldquo;{query}&rdquo;
          </p>
        )}

        {results.length > 0 && (
          <ul className="list-none divide-y divide-[var(--rd-border)]">
            {results.map((r, i) => (
              <ResultListItem key={r.word} word={r.word} similarity={r.similarity} index={i} />
            ))}
          </ul>
        )}

        {canLoadMore && (
          <button
            type="button"
            onClick={() => {
              play("click");
              setK((prev) => prev + LOAD_MORE_STEP);
            }}
            className="font-mono mt-4 text-xs uppercase tracking-wide hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ color: "var(--rd-accent)", outlineColor: "var(--rd-accent)" }}
          >
            Load more entries
          </button>
        )}
      </div>
    </main>
  );
}
