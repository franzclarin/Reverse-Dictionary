"use client";

import Link from "next/link";
import { ReverseDictionaryResponse } from "@/types";

interface ResultDisplayProps {
  result: ReverseDictionaryResponse | null;
  error: string | null;
}

export default function ResultDisplay({ result, error }: ResultDisplayProps) {
  if (error) {
    return (
      <div
        className="w-full p-6 rounded-lg"
        style={{
          border: "1px solid rgba(224,82,82,0.25)",
          background: "rgba(224,82,82,0.05)",
        }}
      >
        <p className="font-serif text-xl italic mb-1" style={{ color: "var(--text-primary)" }}>
          We couldn&apos;t find a word for that.
        </p>
        <p className="font-mono text-sm" style={{ color: "var(--text-secondary)" }}>
          {error}
        </p>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="w-full">
      <div
        className="p-7 rounded-lg animate-fade-up"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          animationDelay: "0ms",
        }}
      >
        {/* Word + full page link */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <h2
            className="font-serif leading-tight"
            style={{ fontSize: "clamp(2.5rem,6vw,3.5rem)", color: "var(--text-primary)" }}
          >
            {result.word}
          </h2>
          <Link
            href={`/word/${encodeURIComponent(result.word.toLowerCase())}`}
            className="shrink-0 mt-2 font-mono text-xs px-2.5 py-1 rounded transition-colors"
            style={{
              color: "var(--accent-gold)",
              border: "1px solid rgba(201,168,76,0.3)",
            }}
          >
            Full page ↗
          </Link>
        </div>

        {/* Definition */}
        <p
          className="font-light text-lg leading-relaxed mb-6"
          style={{ color: "var(--text-primary)" }}
        >
          {result.definition}
        </p>

        {/* Examples */}
        {result.examples && result.examples.length > 0 && (
          <div className="mb-6">
            <p
              className="font-mono text-[10px] uppercase tracking-widest mb-3"
              style={{ color: "var(--accent-gold)" }}
            >
              Examples
            </p>
            <ul className="space-y-2">
              {result.examples.map((example, i) => (
                <li
                  key={i}
                  className="flex gap-3 font-light italic text-sm leading-relaxed pl-4"
                  style={{
                    color: "var(--text-secondary)",
                    borderLeft: "1px solid var(--border)",
                  }}
                >
                  {example}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Alternatives */}
        {result.alternatives && result.alternatives.length > 0 && (
          <div>
            <p
              className="font-mono text-[10px] uppercase tracking-widest mb-3"
              style={{ color: "var(--accent-gold)" }}
            >
              Related Words
            </p>
            <div className="flex flex-wrap gap-2">
              {result.alternatives.map((alt, i) => (
                <Link
                  key={i}
                  href={`/word/${encodeURIComponent(alt.toLowerCase())}`}
                  className="px-3 py-1 font-mono text-xs rounded-full transition-colors"
                  style={{
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "rgba(201,168,76,0.4)";
                    e.currentTarget.style.color = "var(--accent-gold)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                  }}
                >
                  {alt}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
