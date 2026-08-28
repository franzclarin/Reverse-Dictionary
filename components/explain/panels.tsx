"use client";

import { useEffect, useRef } from "react";
import type { PlacedSynset, Run } from "./types";
import type { Token } from "@/lib/viz/wordpiece";

/**
 * The parts of the pipeline that are data rather than geometry.
 *
 * RD-18's own judgement, kept: 384 numbers are a strip, not a shape; attention
 * heads are not spatial, so any 3D rendering of them would be decoration that
 * implies structure; and a ranked list is a list. Drawing these flat is the
 * honest choice, not the lazy one.
 */

export const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--rd-ink-muted)",
};

export function PanelLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2">
      <span className="font-mono" style={LABEL_STYLE}>
        {children}
      </span>
      {right && (
        <span className="font-mono" style={{ ...LABEL_STYLE, letterSpacing: "0.04em" }}>
          {right}
        </span>
      )}
    </div>
  );
}

/** Stage 2 — the tokenizer's actual output, produced in the browser. */
export function TokenStrip({ tokens, truncated }: { tokens: Token[]; truncated: boolean }) {
  if (tokens.length === 0) return null;
  return (
    <div>
      <PanelLabel right={`${tokens.length} pieces of 30,522`}>WordPiece</PanelLabel>
      <div className="flex flex-wrap gap-1">
        {tokens.map((token, i) => (
          <span
            key={`${token.id}-${i}`}
            className="font-mono"
            title={`id ${token.id}`}
            style={{
              fontSize: 12,
              padding: "3px 7px",
              borderRadius: 2,
              border: "1px solid var(--rd-border)",
              background: token.special
                ? "var(--rd-hover)"
                : token.unknown
                  ? "var(--rd-accent-soft)"
                  : "transparent",
              color: token.special
                ? "var(--rd-ink-muted)"
                : token.continuation
                  ? "var(--rd-accent)"
                  : "var(--rd-ink)",
            }}
          >
            {token.text}
          </span>
        ))}
      </div>
      <p className="font-mono mt-2" style={{ fontSize: 11, color: "var(--rd-ink-muted)" }}>
        <span style={{ color: "var(--rd-accent)" }}>##</span> continues the word before it ·{" "}
        [CLS] and [SEP] are pooled along with everything else
        {truncated && " · input exceeded 256 pieces and was cut"}
      </p>
    </div>
  );
}

/**
 * Stage 3 — six layers, twelve heads, no decoder.
 *
 * Every cell is drawn IDENTICALLY, on purpose. An earlier version varied their
 * opacity and it looked like a heatmap of attention weights — which would have
 * been invented data, since nothing here reads the model's activations. This is
 * a diagram of the architecture's shape and nothing more, and it says so.
 */
export function EncoderSchematic({ active }: { active: boolean }) {
  return (
    <div>
      <PanelLabel right="6 layers · 384 hidden · 12 heads">BertModel</PanelLabel>
      <div className="flex flex-col gap-[3px]">
        {Array.from({ length: 6 }, (_, layer) => (
          <div key={layer} className="flex gap-[3px] items-center">
            <span
              className="font-mono"
              style={{ fontSize: 9.5, width: 18, color: "var(--rd-ink-muted)" }}
            >
              L{layer + 1}
            </span>
            {Array.from({ length: 12 }, (_, head) => (
              <span
                key={head}
                style={{
                  flex: 1,
                  height: 9,
                  borderRadius: 1,
                  background: active ? "var(--rd-accent)" : "var(--rd-border)",
                  opacity: active ? 0.34 : 1,
                  transition: "opacity 240ms ease-out, background 240ms ease-out",
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <p className="font-mono mt-2" style={{ fontSize: 11, color: "var(--rd-ink-muted)" }}>
        72 attention heads, and <b style={{ color: "var(--rd-ink)" }}>no decoder</b> — this model
        compares meanings, it cannot write one. Cells show the shape of the network, not its
        weights: nothing on this page reads the model&rsquo;s activations.
      </p>
    </div>
  );
}

/** Stage 4/5 — the pooled, normalised vector. These are its real 384 numbers. */
export function VectorHeatmap({ vector }: { vector: number[] | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !vector) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const peak = Math.max(...vector.map(Math.abs)) || 1;
    const cellWidth = width / vector.length;
    vector.forEach((value, i) => {
      const magnitude = Math.abs(value) / peak;
      // Oxblood for positive, ink for negative — sign is real information and
      // a single-hue ramp would throw it away.
      ctx.fillStyle = value >= 0 ? "#7a2e2e" : "#211d19";
      ctx.globalAlpha = 0.12 + magnitude * 0.88;
      ctx.fillRect(i * cellWidth, 0, Math.max(cellWidth, 0.75), height);
    });
    ctx.globalAlpha = 1;
  }, [vector]);

  return (
    <div>
      <PanelLabel right={vector ? "unit length · 384 dimensions" : "384 dimensions"}>
        Mean pooling → L2 normalise
      </PanelLabel>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: 34,
          border: "1px solid var(--rd-border)",
          background: "var(--rd-paper)",
        }}
      />
      <p className="font-mono mt-2" style={{ fontSize: 11, color: "var(--rd-ink-muted)" }}>
        {vector
          ? "One column per dimension. Oxblood is positive, ink negative — these are the query's real coordinates."
          : "The description, once it is only numbers."}
      </p>
    </div>
  );
}

/**
 * Stage 7 — the centrepiece.
 *
 * One retrieved node bursting into its member words at IDENTICAL scores. This
 * is the least understood step in the pipeline and the one a stock diagram gets
 * wrong: what was ranked is a sense, not a word, and the words that fall out of
 * it are tied by construction because they share one vector.
 */
export function SynsetExpansion({ synsets }: { synsets: PlacedSynset[] }) {
  const interesting = synsets.find((s) => s.lemmas.length > 1) ?? synsets[0];
  if (!interesting) return null;

  return (
    <div>
      <PanelLabel right={`rank ${interesting.rank + 1} of ${synsets.length}`}>
        Synset → lemmas
      </PanelLabel>

      <div
        style={{
          border: "1px solid var(--rd-border)",
          borderLeft: "3px solid var(--rd-accent)",
          padding: "10px 12px",
          background: "var(--rd-accent-soft)",
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono" style={{ fontSize: 11, color: "var(--rd-ink-muted)" }}>
            {interesting.synsetKey}
          </span>
          <span className="font-mono" style={{ fontSize: 12, color: "var(--rd-accent)" }}>
            {interesting.similarity.toFixed(4)}
          </span>
        </div>
        <p style={{ fontSize: 13.5, marginTop: 4, color: "var(--rd-ink-gloss)" }}>
          {interesting.gloss}
        </p>
      </div>

      <div className="flex justify-center" aria-hidden="true">
        <span style={{ width: 1, height: 16, background: "var(--rd-border)" }} />
      </div>

      <div className="flex flex-wrap gap-2">
        {interesting.lemmas.map((lemma, i) => (
          <span
            key={lemma}
            className="rd-fade-in-up"
            style={{
              animationDelay: `${i * 60}ms`,
              display: "inline-flex",
              alignItems: "baseline",
              gap: 8,
              border: "1px solid var(--rd-border)",
              padding: "4px 9px",
              borderRadius: 2,
              background: "var(--rd-paper)",
            }}
          >
            <span className="font-serif" style={{ fontSize: 15 }}>
              {lemma}
            </span>
            <span className="font-mono" style={{ fontSize: 11, color: "var(--rd-accent)" }}>
              {interesting.similarity.toFixed(4)}
            </span>
          </span>
        ))}
      </div>

      <p className="font-mono mt-3" style={{ fontSize: 11, color: "var(--rd-ink-muted)" }}>
        {interesting.lemmas.length > 1 ? (
          <>
            All {interesting.lemmas.length} words score <b style={{ color: "var(--rd-ink)" }}>exactly the same</b>,
            because they share one stored vector. Retrieval genuinely cannot separate them; the order
            you see is WordNet&rsquo;s own, a familiarity prior rather than a result.
          </>
        ) : (
          <>This sense has a single member word, so nothing to break a tie between.</>
        )}
      </p>
    </div>
  );
}

/** Stage 8 — a list, drawn as a list, with tied scores visibly tied. */
export function RankedList({ run }: { run: Run }) {
  if (run.results.length === 0) return null;

  const bySimilarity = new Map<string, number>();
  for (const row of run.results) {
    bySimilarity.set(row.similarity.toFixed(6), (bySimilarity.get(row.similarity.toFixed(6)) ?? 0) + 1);
  }

  return (
    <div>
      <PanelLabel right={`${run.timingMs} ms · embed + database`}>Ranked words</PanelLabel>
      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {run.results.map((row, i) => {
          const key = row.similarity.toFixed(6);
          const tied = (bySimilarity.get(key) ?? 0) > 1;
          const firstOfTie = i === 0 || run.results[i - 1].similarity.toFixed(6) !== key;
          return (
            <li
              key={row.word}
              className="rd-fade-in-up flex items-baseline gap-3"
              style={{
                animationDelay: `${i * 30}ms`,
                padding: "6px 0",
                borderBottom: "1px solid var(--rd-border)",
                borderLeft: tied ? "2px solid var(--rd-accent-soft)" : "2px solid transparent",
                paddingLeft: 10,
              }}
            >
              <span className="font-mono" style={{ fontSize: 11, color: "var(--rd-ink-muted)", width: 20 }}>
                {i + 1}
              </span>
              <a
                href={`/word/${encodeURIComponent(row.word)}`}
                className="font-serif hover:underline"
                style={{ fontSize: 17, flex: 1 }}
              >
                {row.word}
              </a>
              <span className="font-mono" style={{ fontSize: 12, color: "var(--rd-accent)" }}>
                {row.similarity.toFixed(4)}
              </span>
              {tied && (
                <span
                  className="font-mono"
                  style={{ fontSize: 10, color: "var(--rd-ink-muted)", width: 52, textAlign: "right" }}
                >
                  {firstOfTie ? "tied ↴" : "tied"}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The retrieved senses, before expansion — what was actually ranked. */
export function SynsetList({ synsets }: { synsets: PlacedSynset[] }) {
  if (synsets.length === 0) return null;
  return (
    <div>
      <PanelLabel right={`${synsets.length} senses`}>What was actually ranked</PanelLabel>
      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {synsets.map((synset) => (
          <li
            key={synset.synsetKey}
            style={{ padding: "7px 0", borderBottom: "1px solid var(--rd-border)" }}
          >
            <div className="flex items-baseline gap-3">
              <span className="font-mono" style={{ fontSize: 11, color: "var(--rd-ink-muted)", width: 20 }}>
                {synset.rank + 1}
              </span>
              <span className="font-serif" style={{ fontSize: 15, flex: 1 }}>
                {synset.lemmas.join(", ")}
              </span>
              <span className="font-mono" style={{ fontSize: 12, color: "var(--rd-accent)" }}>
                {synset.similarity.toFixed(4)}
              </span>
            </div>
            <p style={{ fontSize: 13, color: "var(--rd-ink-gloss)", paddingLeft: 32 }}>
              {synset.gloss}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
