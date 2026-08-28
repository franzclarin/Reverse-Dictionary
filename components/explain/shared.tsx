"use client";

import { useState } from "react";
import { useSound } from "@/context/SoundContext";
import { APPROXIMATIONS, type Stage } from "./stages";
import type { Snapshot } from "./types";

/**
 * Example queries, every one of which lands its intended word at rank 1.
 *
 * **Verified against the live index, not guessed.** Two of the originals did
 * not work and had to go: "the smell of rain on dry earth" returned `humidity`
 * — and could never have been right, because `petrichor` is not in the
 * vocabulary at all (see RD-17) — and "a fear of being forgotten after you die"
 * returned `thanatophobia`, which is the fear of death itself.
 *
 * Each one also has a rank-1 synset with **more than one member**, so stage 7
 * always has a real tie to demonstrate rather than a lone word:
 *
 *   wandering, roving, vagabondage        0.726
 *   sunset, sundown                       0.745
 *   bibliophile, booklover, book lover    0.931
 *   ambidextrous, two-handed              0.761
 *
 * **Retest before changing this list**, and retest it wholesale if the index is
 * ever rebuilt. A broken example is the first thing a visitor clicks.
 */
export const EXAMPLES = [
  "walking without a destination in mind",
  "the last light before the sun goes down",
  "a person who loves books",
  "able to use both hands equally well",
];

export function QueryBar({
  onSearch,
  busy,
  initial = "",
  compact = false,
}: {
  onSearch: (query: string) => void;
  busy: boolean;
  initial?: string;
  compact?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const { play } = useSound();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!value.trim() || busy) return;
    play("return");
    onSearch(value);
  };

  return (
    <form onSubmit={submit} className="w-full">
      <div
        className="flex items-center gap-2 w-full"
        style={{
          border: "1px solid var(--rd-border)",
          background: "var(--rd-paper)",
          padding: compact ? "0 6px 0 12px" : "0 8px 0 14px",
          height: compact ? 44 : 52,
        }}
      >
        <input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            play("key");
          }}
          maxLength={500}
          placeholder="describe something, and watch it get found"
          aria-label="Describe a concept"
          className="flex-1 bg-transparent outline-none"
          style={{ fontSize: compact ? 14 : 15, color: "var(--rd-ink)" }}
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="font-mono"
          style={{
            fontSize: 11,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            padding: "7px 14px",
            background: busy || !value.trim() ? "var(--rd-border)" : "var(--rd-accent)",
            color: busy || !value.trim() ? "var(--rd-ink-muted)" : "var(--rd-paper)",
            cursor: busy || !value.trim() ? "default" : "pointer",
          }}
        >
          {busy ? "running" : "run it"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mt-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setValue(example);
              play("click");
              onSearch(example);
            }}
            className="font-mono"
            style={{
              fontSize: 11,
              padding: "3px 8px",
              border: "1px solid var(--rd-border)",
              color: "var(--rd-ink-muted)",
              background: "transparent",
              cursor: "pointer",
              borderRadius: 2,
            }}
          >
            {example}
          </button>
        ))}
      </div>
    </form>
  );
}

/** The measured PCA figure. RD-18 requires this to be on screen, not in a doc. */
export function VarianceNote({ snapshot, inverted = false }: { snapshot: Snapshot; inverted?: boolean }) {
  const colour = inverted ? "rgba(250,247,242,0.72)" : "var(--rd-ink-muted)";
  return (
    <p className="font-mono" style={{ fontSize: 11, lineHeight: 1.6, color: colour }}>
      Three components carry{" "}
      <b style={{ color: inverted ? "#faf7f2" : "var(--rd-ink)" }}>
        {(snapshot.varianceExplained * 100).toFixed(1)}%
      </b>{" "}
      of the variance in 384 dimensions. The other{" "}
      {(100 - snapshot.varianceExplained * 100).toFixed(1)}% is not on this screen.
    </p>
  );
}

/**
 * The four approximations, permanently visible.
 *
 * Not a disclosure widget by accident: the short line is always rendered, and
 * only the elaboration is behind the toggle. RD-18 calls this the
 * acceptance-critical step — a pretty picture is more persuasive than a correct
 * one, so the caveats do not get to hide.
 */
export function ApproximationNotes({
  snapshot,
  inverted = false,
  columns = 1,
}: {
  snapshot: Snapshot;
  inverted?: boolean;
  columns?: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const ink = inverted ? "#faf7f2" : "var(--rd-ink)";
  const muted = inverted ? "rgba(250,247,242,0.66)" : "var(--rd-ink-muted)";
  const line = inverted ? "rgba(250,247,242,0.18)" : "var(--rd-border)";

  return (
    <div>
      <p
        className="font-mono mb-2"
        style={{ fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: muted }}
      >
        What this picture approximates
      </p>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: "0 24px",
        }}
      >
        {APPROXIMATIONS.map((item, i) => (
          <li key={item.short} style={{ borderTop: `1px solid ${line}`, padding: "6px 0" }}>
            <button
              type="button"
              onClick={() => setOpen(open === i ? null : i)}
              className="font-mono text-left w-full"
              style={{ fontSize: 11.5, color: ink, background: "none", border: 0, cursor: "pointer", padding: 0 }}
            >
              <span style={{ color: muted }}>{open === i ? "−" : "+"}</span> {item.short}
            </button>
            {open === i && (
              <p style={{ fontSize: 12.5, lineHeight: 1.55, color: muted, marginTop: 4 }}>
                {i === 1
                  ? `${snapshot.sampled.toLocaleString()} senses are drawn here. Retrieval searches all ${snapshot.indexRows.toLocaleString()}, every time.`
                  : item.long}
              </p>
            )}
          </li>
        ))}
      </ul>
      {/*
        Attribution, permanently visible for the same reason the caveats above
        are: the glosses this page displays are somebody else's work. WordNet
        3.0 supplies 117,791 of the senses; the rest come from English
        Wiktionary via the Kaikki.org wiktextract extraction (RD-17), which is
        CC BY-SA — attribution AND share-alike, an obligation WordNet's licence
        does not impose and which travels with anything derived from this index.
      */}
      <p
        className="font-mono"
        style={{ fontSize: 10.5, lineHeight: 1.5, color: muted, marginTop: 10 }}
      >
        Sense definitions: Princeton WordNet 3.0, and English Wiktionary via
        Kaikki.org (CC BY-SA 4.0).
      </p>
    </div>
  );
}

export function StageCaption({
  stage,
  active,
  inverted = false,
  onClick,
}: {
  stage: Stage;
  active: boolean;
  inverted?: boolean;
  onClick?: () => void;
}) {
  const ink = inverted ? "#faf7f2" : "var(--rd-ink)";
  const muted = inverted ? "rgba(250,247,242,0.6)" : "var(--rd-ink-muted)";

  return (
    <div
      onClick={onClick}
      style={{
        cursor: onClick ? "pointer" : "default",
        opacity: active ? 1 : 0.42,
        transition: "opacity 260ms ease-out",
      }}
    >
      <div className="flex items-baseline gap-3">
        <span className="font-mono" style={{ fontSize: 11, color: "var(--rd-accent)" }}>
          {String(stage.n).padStart(2, "0")}
        </span>
        <span
          className="font-mono"
          style={{ fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase", color: muted }}
        >
          {stage.title}
        </span>
      </div>
      <p className="font-serif" style={{ fontSize: 19, lineHeight: 1.25, color: ink, marginTop: 3 }}>
        {stage.operation}
      </p>
      <p style={{ fontSize: 13.5, lineHeight: 1.6, color: muted, marginTop: 6 }}>{stage.caption}</p>
      <p className="font-mono" style={{ fontSize: 10.5, color: muted, marginTop: 6, opacity: 0.75 }}>
        {stage.where}
      </p>
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p
      className="font-mono"
      style={{
        fontSize: 12,
        color: "var(--rd-error)",
        border: "1px solid var(--rd-error)",
        padding: "8px 10px",
        background: "var(--rd-accent-soft)",
      }}
    >
      {message}
    </p>
  );
}
