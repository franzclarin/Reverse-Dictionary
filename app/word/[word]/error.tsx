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
    <main className="max-w-3xl mx-auto px-6 py-24 text-center">
      <h1
        className="font-serif mb-4"
        style={{ fontSize: "clamp(2rem,5vw,3rem)", color: "var(--text-primary)" }}
      >
        This word didn&apos;t load
      </h1>
      <p className="font-light mb-8" style={{ color: "var(--text-secondary)" }}>
        Something went wrong fetching this entry. The search itself is fine — try
        again, or look up a different word.
      </p>
      <div className="flex items-center justify-center gap-3 flex-wrap">
        <button
          onClick={reset}
          className="px-5 py-2 font-mono text-sm rounded transition-opacity hover:opacity-90"
          style={{ background: "var(--accent-gold)", color: "var(--bg)" }}
        >
          Try again
        </button>
        <Link
          href="/"
          className="px-5 py-2 font-mono text-sm rounded transition-opacity hover:opacity-80"
          style={{ color: "var(--text-primary)", border: "1px solid var(--border)" }}
        >
          New search →
        </Link>
      </div>
      {error.digest && (
        <p
          className="font-mono text-xs mt-8"
          style={{ color: "var(--text-secondary)" }}
        >
          Reference: {error.digest}
        </p>
      )}
    </main>
  );
}
