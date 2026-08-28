"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PointCloud, { PLATE_THEME, type ScreenRef } from "./PointCloud";
import TransformFilm from "./TransformFilm";
import { STAGES } from "./stages";
import { ApproximationNotes, ErrorNote, QueryBar, VarianceNote } from "./shared";
import {
  EncoderSchematic,
  RankedList,
  SynsetExpansion,
  SynsetList,
  TokenStrip,
  VectorHeatmap,
} from "./panels";
import { useSound } from "@/context/SoundContext";
import type { Run, Snapshot } from "./types";

/**
 * The /explain page's one layout.
 *
 * The cloud fills the frame; the transformation plays over it as a film; the
 * prose sits in a card you can put away. Three surfaces, in that order of
 * importance — RD-18's whole argument is that this pipeline is legible if you
 * can *watch* it, and the paragraphs are a fallback rather than the point.
 *
 * What is NOT hideable: the four approximation labels along the bottom. RD-18
 * calls labelling them "the acceptance-critical step, not the polish step", and
 * a control that tucked the caveats away while leaving the persuasive picture
 * running would invert the reason they exist.
 */

const STEPS_STORAGE_KEY = "rd-explain-steps-open";
const CARD_WIDTH = 396;

type Props = {
  snapshot: Snapshot;
  run: Run;
  search: (query: string) => void;
};

export default function InstrumentShell({ snapshot, run, search }: Props) {
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(true);
  const { play } = useSound();

  // Written by PointCloud every frame, read by the film so the vector's flight
  // ends on the real projected query position.
  const screenRef = useRef<ScreenRef>({ query: null });

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STEPS_STORAGE_KEY);
      if (stored !== null) setStepsOpen(stored === "true");
    } catch {
      // Private mode, or site data blocked. Default open is the right fallback.
    }
  }, []);

  const toggleSteps = useCallback(() => {
    play("click");
    setStepsOpen((open) => {
      try {
        window.localStorage.setItem(STEPS_STORAGE_KEY, String(!open));
      } catch {
        // Preference simply does not persist; the control still works.
      }
      return !open;
    });
  }, [play]);

  // A landed result replays the film from the top.
  useEffect(() => {
    if (run.phase !== "done") return;
    setStage(0);
    setPlaying(true);
  }, [run.phase, run.query]);

  // The updater stays PURE — no setPlaying inside it. React StrictMode invokes
  // updaters twice to surface exactly this, and a state write hidden in one is
  // a render-phase side effect.
  const advance = useCallback(() => {
    setStage((current) => (current >= STAGES.length - 1 ? current : current + 1));
  }, []);

  useEffect(() => {
    if (stage >= STAGES.length - 1) setPlaying(false);
  }, [stage]);

  const current = STAGES[stage];
  const hasRun = run.phase === "done";
  const past = (n: number) => stage >= n - 1;

  return (
    <main
      style={{
        background: "var(--rd-ink)",
        height: "calc(100vh - 64px)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <PointCloud
        snapshot={snapshot}
        synsets={run.synsets}
        queryPoint={run.queryPoint}
        showLinks={past(6)}
        emphasiseHits={past(6)}
        theme={PLATE_THEME}
        screenRef={screenRef}
        // The film has custody of the vector until it flies into the cloud;
        // two markers for one query would read as two queries.
        hideQueryMarker={hasRun && stage < 5}
        controlsBottom={196}
        style={{ position: "absolute", inset: 0 }}
      />

      {hasRun && (
        <TransformFilm
          tokens={run.tokens}
          tokenVectors={run.tokenVectors}
          queryVector={run.queryVector}
          tokenVectorsTruncated={run.tokenVectorsTruncated}
          stage={stage}
          playing={playing}
          onAdvance={advance}
          screenRef={screenRef}
          leftInset={0}
          rightInset={stepsOpen ? CARD_WIDTH + 40 : 0}
          // Clears the query card above and the scrubber below, so the band
          // never tucks under either.
          topInset={210}
          bottomInset={186}
        />
      )}

      {/* Top left: the query, on its own paper so it stays legible over the cloud. */}
      <div style={{ position: "absolute", top: 20, left: 20, width: "min(600px, calc(100% - 40px))" }}>
        <div
          style={{
            background: "rgba(250,247,242,0.94)",
            border: "1px solid var(--rd-border)",
            padding: 14,
            backdropFilter: "blur(6px)",
          }}
        >
          <QueryBar onSearch={search} busy={run.phase === "searching"} compact />
          {run.error && (
            <div className="mt-3">
              <ErrorNote message={run.error} />
            </div>
          )}
        </div>
      </div>

      {/* Right: the steps, hideable. */}
      {stepsOpen ? (
        <div
          style={{
            position: "absolute",
            top: 20,
            right: 20,
            bottom: 186,
            width: CARD_WIDTH,
            maxWidth: "calc(100% - 40px)",
            background: "rgba(250,247,242,0.95)",
            border: "1px solid var(--rd-border)",
            backdropFilter: "blur(6px)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            className="flex items-center gap-3"
            style={{ padding: "10px 14px", borderBottom: "1px solid var(--rd-border)" }}
          >
            <span className="font-mono" style={{ fontSize: 11, color: "var(--rd-accent)" }}>
              {String(current.n).padStart(2, "0")}
            </span>
            <span
              className="font-mono"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "var(--rd-ink-muted)",
              }}
            >
              {current.title}
            </span>
            <button
              type="button"
              onClick={toggleSteps}
              aria-label="Hide the steps"
              className="font-mono ml-auto"
              style={{
                fontSize: 13,
                lineHeight: 1,
                padding: "4px 8px",
                border: "1px solid var(--rd-border)",
                background: "transparent",
                color: "var(--rd-ink-muted)",
                cursor: "pointer",
                borderRadius: 2,
              }}
            >
              &minus;
            </button>
          </div>

          {/* `minHeight: 0` is what lets this scroll instead of pushing the card. */}
          <div style={{ padding: "14px 16px 18px", overflowY: "auto", minHeight: 0 }}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-serif" style={{ fontSize: 20, lineHeight: 1.2 }}>
                {current.operation}
              </p>
              <span className="font-mono" style={{ fontSize: 10, color: "var(--rd-ink-muted)" }}>
                {current.where}
              </span>
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--rd-ink-secondary)", marginTop: 8 }}>
              {current.caption}
            </p>

            <div className="mt-5">
              {current.id === "tokenize" && <TokenStrip tokens={run.tokens} truncated={run.truncated} />}
              {current.id === "encode" && <EncoderSchematic active={hasRun} />}
              {(current.id === "pool" || current.id === "normalize") && (
                <VectorHeatmap vector={run.queryVector} />
              )}
              {current.id === "retrieve" && <SynsetList synsets={run.synsets} />}
              {current.id === "expand" && <SynsetExpansion synsets={run.synsets} />}
              {current.id === "render" && <RankedList run={run} />}
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={toggleSteps}
          className="font-mono"
          style={{
            position: "absolute",
            top: 20,
            right: 20,
            fontSize: 11,
            padding: "7px 12px",
            border: "1px solid rgba(250,247,242,0.28)",
            background: "rgba(33,29,25,0.86)",
            color: "#faf7f2",
            cursor: "pointer",
            backdropFilter: "blur(6px)",
          }}
        >
          ▤ steps
        </button>
      )}

      {/* Bottom: the scrubber, and the caveats that never hide. */}
      <div
        style={{
          position: "absolute",
          left: 20,
          right: 20,
          bottom: 20,
          background: "rgba(33,29,25,0.88)",
          border: "1px solid rgba(250,247,242,0.16)",
          padding: "12px 16px",
          backdropFilter: "blur(6px)",
        }}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              play("click");
              setPlaying((p) => !p);
            }}
            disabled={!hasRun}
            className="font-mono"
            style={{
              fontSize: 11,
              padding: "5px 10px",
              border: "1px solid rgba(250,247,242,0.28)",
              background: "transparent",
              color: hasRun ? "#faf7f2" : "rgba(250,247,242,0.4)",
              cursor: hasRun ? "pointer" : "default",
            }}
          >
            {playing ? "❙❙ pause" : "▶ replay"}
          </button>
          <input
            type="range"
            min={0}
            max={STAGES.length - 1}
            value={stage}
            disabled={!hasRun}
            onChange={(event) => {
              setPlaying(false);
              setStage(Number(event.target.value));
            }}
            aria-label="Pipeline stage"
            style={{ flex: 1, accentColor: "#e88b6a" }}
          />
          <span
            className="font-mono"
            style={{ fontSize: 11, color: "rgba(250,247,242,0.7)", width: 76, textAlign: "right" }}
          >
            {stage + 1} / {STAGES.length}
          </span>
        </div>

        <div className="mt-3 grid gap-4 md:grid-cols-[1fr_1.6fr]">
          <VarianceNote snapshot={snapshot} inverted />
          <ApproximationNotes snapshot={snapshot} inverted columns={2} />
        </div>
      </div>
    </main>
  );
}
