"use client";

import { useEffect, useRef, useState } from "react";
import { useSound } from "@/context/SoundContext";

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

/** Thin cursor appended to the placeholder while the typewriter is animating. */
const CURSOR = "▏";

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
        setText(phrase.slice(0, charIndex) + CURSOR);
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
      setText(phrase.slice(0, charIndex) + CURSOR);
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
  const { play } = useSound();

  const placeholder = useTypewriterPlaceholder(
    description.length === 0 && !isFocused
  );
  const isCompact = variant === "compact";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (description.trim() && !isLoading) {
      play("return");
      onSearch(description.trim());
    }
  };

  // Fires on the keys that actually change the field's text — a typewriter
  // key strike per character, not per event (ignores modifiers, arrows, etc).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
      play("key");
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
        className="flex items-center rounded-xl transition-all duration-150 ease-out hover:shadow-[0_2px_12px_rgba(122,46,46,0.1)] focus-within:shadow-none focus-within:outline focus-within:outline-2 focus-within:outline-offset-2"
        style={{
          height: isCompact ? "42px" : "52px",
          background: "#ffffff",
          border: "1px solid var(--rd-border)",
          outlineColor: "var(--rd-accent)",
        }}
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          className="ml-4 shrink-0"
          style={{ color: "var(--rd-ink-muted)" }}
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
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={placeholder}
          autoComplete="off"
          disabled={isLoading}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 outline-none font-sans"
          style={{
            fontSize: isCompact ? "15px" : "17px",
            color: "var(--rd-ink)",
          }}
        />

        <button
          type="submit"
          disabled={!description.trim() || isLoading}
          aria-label="Search"
          onMouseEnter={() => setIsButtonHovered(true)}
          onMouseLeave={() => setIsButtonHovered(false)}
          className="mr-2 grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          style={{
            color: isButtonHovered ? "#ffffff" : "var(--rd-accent)",
            outlineColor: "var(--rd-accent)",
            background: isButtonHovered ? "var(--rd-accent)" : "var(--rd-accent-soft)",
          }}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
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
