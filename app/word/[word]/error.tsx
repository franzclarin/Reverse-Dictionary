"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Safety net so a server-side exception renders something legible instead of
 * Next's bare "Application error: a server-side exception has occurred".
 */
export default function WordError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Word page error:", error);
  }, [error]);

  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center px-6 py-24 text-center"
      style={{ background: "var(--rd-paper)" }}
    >
      <h1
        className="font-serif mb-4"
        style={{ fontSize: "clamp(1.75rem,4vw,2.5rem)", fontWeight: 400, color: "var(--rd-ink)" }}
      >
        This word didn&apos;t load
      </h1>
      <p className="font-sans mb-8" style={{ color: "var(--rd-ink-secondary)" }}>
        Something went wrong fetching this entry. The search itself is fine — try
        again, or look up a different word.
      </p>
      <div className="flex items-center justify-center gap-3 flex-wrap">
        <button
          onClick={reset}
          className="font-sans px-5 py-2 text-sm font-medium rounded-md transition-colors hover:bg-[var(--rd-accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ background: "var(--rd-accent)", color: "#ffffff", outlineColor: "var(--rd-accent)" }}
        >
          Try again
        </button>
        <Link
          href="/"
          className="font-sans px-5 py-2 text-sm rounded-md transition-colors hover:bg-[var(--rd-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ color: "var(--rd-ink)", border: "1px solid var(--rd-border)", outlineColor: "var(--rd-accent)" }}
        >
          New search →
        </Link>
      </div>
      {error.digest && (
        <p className="font-mono text-xs mt-8" style={{ color: "var(--rd-ink-muted)" }}>
          Reference: {error.digest}
        </p>
      )}
    </main>
  );
}
