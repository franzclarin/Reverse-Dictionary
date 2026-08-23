"use client";

import { useEffect, useRef, useState } from "react";

interface SearchInputProps {
  onSearch: (description: string) => void;
  isLoading: boolean;
  variant?: "landing" | "compact";
  /** Seeds the field on mount — the results page pre-fills the query that produced the current list. */
  initialValue?: string;
}

const PLACEHOLDER_EXAMPLES = [
  "a feeling of nostalgia for a place you've never been",
  "when you say something and immediately regret it",
  "the smell of rain on dry earth",
  "happy and sad at the same time",
  "fear of long words",
];

const TYPE_SPEED_MS = 45;
const DELETE_SPEED_MS = 25;
const PAUSE_AFTER_TYPE_MS = 1800;
const PAUSE_AFTER_DELETE_MS = 400;

/**
 * Types/pauses/deletes through PLACEHOLDER_EXAMPLES while `active`, freezing
 * (not clearing) the current text when `active` goes false — the box is
 * empty and unfocused, or the box has a cursor in it but browsers only show
 * placeholder text while the value is empty, so freezing vs. clearing only
 * matters for that one case, and freezing reads as "paused" rather than "reset".
 * Renders the first example statically under prefers-reduced-motion.
 */
function useTypewriterPlaceholder(active: boolean): string {
  const [text, setText] = useState("");
  const reducedMotion = useRef(false);

  useEffect(() => {
    reducedMotion.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
  }, []);

  useEffect(() => {
    if (!active) return;
    setText("");

    if (reducedMotion.current) {
      setText(PLACEHOLDER_EXAMPLES[0]);
      return;
    }

    let phraseIndex = 0;
    let charIndex = 0;
    let phase: "typing" | "pausing" | "deleting" = "typing";
    let timeoutId: ReturnType<typeof setTimeout>;

    const tick = () => {
      const phrase = PLACEHOLDER_EXAMPLES[phraseIndex];

      if (phase === "typing") {
        charIndex += 1;
        setText(phrase.slice(0, charIndex));
        if (charIndex >= phrase.length) {
          phase = "pausing";
          timeoutId = setTimeout(tick, PAUSE_AFTER_TYPE_MS);
        } else {
          timeoutId = setTimeout(tick, TYPE_SPEED_MS);
        }
        return;
      }

      if (phase === "pausing") {
        phase = "deleting";
        timeoutId = setTimeout(tick, DELETE_SPEED_MS);
        return;
      }

      charIndex -= 1;
      setText(phrase.slice(0, charIndex));
      if (charIndex <= 0) {
        phase = "typing";
        phraseIndex = (phraseIndex + 1) % PLACEHOLDER_EXAMPLES.length;
        timeoutId = setTimeout(tick, PAUSE_AFTER_DELETE_MS);
      } else {
        timeoutId = setTimeout(tick, DELETE_SPEED_MS);
      }
    };

    timeoutId = setTimeout(tick, TYPE_SPEED_MS);
    return () => clearTimeout(timeoutId);
  }, [active]);

  return text;
}

export default function SearchInput({
  onSearch,
  isLoading,
  variant = "landing",
  initialValue = "",
}: SearchInputProps) {
  const [description, setDescription] = useState(initialValue);
  const [isFocused, setIsFocused] = useState(false);
  const [isButtonHovered, setIsButtonHovered] = useState(false);

  const placeholder = useTypewriterPlaceholder(
    description.length === 0 && !isFocused
  );
  const isCompact = variant === "compact";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (description.trim() && !isLoading) {
      onSearch(description.trim());
    }
  };

  return (
    <form
      id={`search-form-${variant}`}
      onSubmit={handleSubmit}
      role="search"
      className="w-full"
    >
      <div
        className="flex items-center rounded-full transition-all duration-150 ease-out focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:shadow-[0_1px_6px_rgba(32,33,36,0.15)]"
        style={{
          height: isCompact ? "40px" : "44px",
          background: "var(--gs-bg)",
          border: "1px solid var(--gs-border)",
          outlineColor: "var(--gs-accent)",
        }}
      >
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          className="ml-4 shrink-0"
          style={{ color: "var(--gs-text-secondary)" }}
        >
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <line
            x1="16.3"
            y1="16.3"
            x2="21"
            y2="21"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>

        <label htmlFor={`search-input-${variant}`} className="sr-only">
          Describe the word you&apos;re looking for
        </label>
        <input
          id={`search-input-${variant}`}
          type="search"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={placeholder}
          autoComplete="off"
          disabled={isLoading}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 outline-none font-google"
          style={{
            fontSize: isCompact ? "16px" : "18px",
            color: "var(--gs-text-primary)",
          }}
        />

        <button
          type="submit"
          disabled={!description.trim() || isLoading}
          aria-label="Search"
          onMouseEnter={() => setIsButtonHovered(true)}
          onMouseLeave={() => setIsButtonHovered(false)}
          className="mr-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          style={{
            color: "var(--gs-accent)",
            outlineColor: "var(--gs-accent)",
            background: isButtonHovered ? "var(--gs-hover-bg)" : "transparent",
          }}
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </form>
  );
}
