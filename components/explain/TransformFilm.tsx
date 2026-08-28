"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Token } from "@/lib/viz/wordpiece";
import type { ScreenRef } from "./PointCloud";

/**
 * The transformation, performed rather than described (RD-18).
 *
 * A phrase splits into sub-words, each sub-word becomes a real block of 384
 * numbers, the blocks average into one, that one is scaled to unit length, and
 * it flies into the cloud. The intent is that watching it is enough — the prose
 * in the steps card explains the same thing again for anyone who wants it, but
 * the animation is not a decoration hanging off the text.
 *
 * EVERY NUMBER DRAWN HERE IS REAL. The tiles are `debug.tokenVectors` from
 * `/api/lookup`, which are the encoder's actual per-token output;
 * `scripts/verify-viz-snapshot.ts` asserts that their mean, normalised, is
 * exactly the query vector the database was searched with. Nothing is
 * synthesised to look like activity — which for this page is the whole point,
 * since a convincing picture of made-up data would be worse than no picture.
 *
 * Rendered on its own transparent canvas layered over `PointCloud`, sharing its
 * screen coordinates, so the hand-off at the end lands on the real projected
 * query position instead of somewhere that merely looks close.
 */

/** How long each pipeline stage holds, in ms. Index matches `STAGES`. */
export const STAGE_DURATIONS = [1500, 2800, 3200, 2300, 1900, 2200, 2800, 3000];

/**
 * Dwell per stage under `prefers-reduced-motion`.
 *
 * Reduced motion removes the MORPHS, not the sequence: each stage snaps to its
 * finished state and holds. Skipping the progression instead would leave the
 * film parked on stage one forever, which is not an accessible version of the
 * page, it is a broken one.
 */
const REDUCED_STAGE_MS = 1200;

/** The operation each stage performs, named. Index matches `STAGES`. */
const OPERATION_LABELS = [
  "YOUR DESCRIPTION",
  "WORDPIECE · 30,522 PIECES",
  "BERTMODEL · 6 LAYERS · 384 HIDDEN",
  "MEAN POOLING",
  "L2 NORMALISE",
  "COSINE SIMILARITY, IN 384 DIMENSIONS",
  "SYNSET → LEMMAS",
  "RANK",
];

const TILE_COLS = 16;
const TILE_ROWS = 24; // 16 x 24 = 384, the whole vector, nothing dropped.

const PAPER = "#faf7f2";
const INK = "#211d19";
const MUTED = "#6f6a5f";
const ACCENT = "#7a2e2e";
const BORDER = "#e2dbcd";

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Ramp that starts at `start` and finishes at `end` within a 0..1 phase. */
const window01 = (t: number, start: number, end: number) => clamp01((t - start) / (end - start));

type Group = { chips: Token[]; word: string };

/** Rebuild whole words from the token stream, so the split has something to split. */
function buildGroups(tokens: Token[]): Group[] {
  const groups: Group[] = [];
  for (const token of tokens) {
    if (token.special) {
      groups.push({ chips: [token], word: token.text });
      continue;
    }
    if (!token.continuation || groups.length === 0 || groups[groups.length - 1].chips[0].special) {
      groups.push({ chips: [token], word: token.text });
      continue;
    }
    const group = groups[groups.length - 1];
    group.chips.push(token);
    group.word += token.text.replace(/^##/, "");
  }
  return groups;
}

/**
 * Pre-render each vector as a 16x24 image once, then scale it when drawing.
 *
 * At small tile sizes the individual cells are sub-pixel, and 384 tiny
 * fillRect calls per token per frame would both alias badly and cost more than
 * the rest of the frame put together.
 */
function renderTile(vector: number[]): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = TILE_COLS;
  canvas.height = TILE_ROWS;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const image = ctx.createImageData(TILE_COLS, TILE_ROWS);
  // Per-tile peak: normalisation only rescales a vector, so a shared scale would
  // make the "set length to 1" beat invisible. The length change is told by the
  // readout instead, and the pattern stays honestly comparable tile to tile.
  let peak = 0;
  for (const value of vector) peak = Math.max(peak, Math.abs(value));
  peak = peak || 1;

  for (let i = 0; i < TILE_COLS * TILE_ROWS; i++) {
    const value = vector[i] ?? 0;
    const magnitude = Math.abs(value) / peak;
    // Oxblood positive, ink negative — sign is real information.
    const [r, g, b] = value >= 0 ? [122, 46, 46] : [33, 29, 25];
    const alpha = 0.08 + magnitude * 0.92;
    const o = i * 4;
    image.data[o] = Math.round(lerp(250, r, alpha));
    image.data[o + 1] = Math.round(lerp(247, g, alpha));
    image.data[o + 2] = Math.round(lerp(242, b, alpha));
    image.data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

type Props = {
  tokens: Token[];
  tokenVectors: number[][];
  queryVector: number[] | null;
  tokenVectorsTruncated: boolean;
  /** Index into `STAGES`. */
  stage: number;
  playing: boolean;
  onAdvance: () => void;
  screenRef: React.MutableRefObject<ScreenRef>;
  /** Horizontal space the chrome occupies, so the band clears it. */
  leftInset: number;
  rightInset: number;
  /** Vertical space the top and bottom chrome take. */
  topInset: number;
  bottomInset: number;
};

export default function TransformFilm({
  tokens,
  tokenVectors,
  queryVector,
  tokenVectorsTruncated,
  stage,
  playing,
  onAdvance,
  screenRef,
  leftInset,
  rightInset,
  topInset,
  bottomInset,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const progress = useRef(0);
  const lastStage = useRef(stage);
  /**
   * Set the instant we ask for the next stage and cleared when it arrives.
   * Without it the "progress is finished" branch fires on every frame between
   * the request and React committing the new prop, skipping stages.
   */
  const advanceRequested = useRef(false);
  const advanceRef = useRef(onAdvance);
  advanceRef.current = onAdvance;

  const groups = useMemo(() => buildGroups(tokens), [tokens]);

  /** The mean of the token vectors, and that mean at unit length. */
  const { meanVector, normalisedVector, meanNorm } = useMemo(() => {
    if (tokenVectors.length === 0) {
      return { meanVector: null, normalisedVector: null, meanNorm: 0 };
    }
    const dim = tokenVectors[0].length;
    const mean = new Array<number>(dim).fill(0);
    for (const vector of tokenVectors) {
      for (let i = 0; i < dim; i++) mean[i] += vector[i];
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      mean[i] /= tokenVectors.length;
      norm += mean[i] * mean[i];
    }
    norm = Math.sqrt(norm) || 1;
    return {
      meanVector: mean,
      normalisedVector: mean.map((v) => v / norm),
      meanNorm: norm,
    };
  }, [tokenVectors]);

  const tiles = useMemo(() => tokenVectors.map(renderTile), [tokenVectors]);
  const meanTile = useMemo(() => (meanVector ? renderTile(meanVector) : null), [meanVector]);
  const finalTile = useMemo(
    // Prefer the server's own vector so the last frame shows exactly what was
    // searched with, not a client-side re-derivation of it.
    () => (queryVector ? renderTile(queryVector) : normalisedVector ? renderTile(normalisedVector) : null),
    [queryVector, normalisedVector]
  );

  const reducedMotion = useRef(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.current = mq.matches;
    const onChange = () => {
      reducedMotion.current = mq.matches;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let previous = performance.now();
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.parentElement?.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect?.width ?? window.innerWidth));
      height = Math.max(1, Math.floor(rect?.height ?? window.innerHeight));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    resize();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const elapsed = now - previous;
      previous = now;

      if (lastStage.current !== stage) {
        lastStage.current = stage;
        progress.current = 0;
        advanceRequested.current = false;
      }

      const duration = reducedMotion.current
        ? REDUCED_STAGE_MS
        : (STAGE_DURATIONS[stage] ?? 2000);
      if (playing && progress.current < 1) {
        progress.current = Math.min(1, progress.current + elapsed / duration);
      } else if (!playing) {
        // Scrubbed to a stage: show its finished state rather than freezing
        // part-way through a morph.
        progress.current = 1;
      }

      // Under reduced motion the clock still runs — it just is not drawn as a
      // tween. Every stage renders at its end state for its whole dwell.
      const shown = reducedMotion.current ? 1 : progress.current;

      ctx.clearRect(0, 0, width, height);
      draw(ctx, width, height, shown);

      if (playing && progress.current >= 1 && !advanceRequested.current) {
        advanceRequested.current = true;
        advanceRef.current();
      }
    };

    /** How far the film has got, as one monotonic number across all stages. */
    const filmProgress = (p: number) => stage + p;

    const draw = (
      context: CanvasRenderingContext2D,
      w: number,
      h: number,
      p: number
    ) => {
      if (groups.length === 0) return;

      const t = filmProgress(p);
      // The film owns stages 0-5; from "retrieve" onward the cloud takes over.
      const handOff = clamp01(t - 5);
      const filmAlpha = 1 - easeOut(handOff);
      if (filmAlpha <= 0.001 && handOff >= 1) return;

      const availableLeft = leftInset + 28;
      const availableRight = w - rightInset - 28;
      const bandWidth = Math.max(320, availableRight - availableLeft);
      const centreX = availableLeft + bandWidth / 2;
      const centreY = topInset + (h - topInset - bottomInset) * 0.42;

      context.save();
      context.globalAlpha = filmAlpha;

      // ---- measure the two chip layouts -------------------------------------
      context.font = '500 13px "DM Mono", ui-monospace, monospace';
      const chipPadding = 7;
      const chipGap = 4;
      const groupGap = 16;

      type Placed = {
        token: Token;
        joinedX: number;
        joinedW: number;
        splitX: number;
        splitW: number;
        groupIndex: number;
      };

      // Split layout: every chip separate, specials included.
      const splitWidths: number[][] = groups.map((group) =>
        group.chips.map((chip) => context.measureText(chip.text).width + chipPadding * 2)
      );
      let splitTotal = 0;
      splitWidths.forEach((widths, g) => {
        splitTotal += widths.reduce((a, b) => a + b, 0) + chipGap * (widths.length - 1);
        if (g < groups.length - 1) splitTotal += groupGap;
      });

      // Joined layout: whole words, specials not yet present.
      const wordGroups = groups.filter((group) => !group.chips[0].special);
      const joinedWidths = wordGroups.map(
        (group) => context.measureText(group.word).width + chipPadding * 2
      );
      const joinedTotal =
        joinedWidths.reduce((a, b) => a + b, 0) + groupGap * Math.max(0, wordGroups.length - 1);

      const placed: Placed[] = [];
      let splitCursor = centreX - splitTotal / 2;
      let joinedCursor = centreX - joinedTotal / 2;
      let wordIndex = 0;

      groups.forEach((group, g) => {
        const isSpecial = group.chips[0].special;
        let joinedGroupX = joinedCursor;
        let joinedGroupW = 0;
        if (!isSpecial) {
          joinedGroupW = joinedWidths[wordIndex];
          joinedCursor += joinedGroupW + groupGap;
          wordIndex++;
        } else {
          // A special has no home in the joined layout: it is born at whichever
          // end of the phrase it belongs to and fades in as the words spread.
          joinedGroupX = g === 0 ? centreX - joinedTotal / 2 : centreX + joinedTotal / 2;
          joinedGroupW = 0;
        }

        let withinJoined = 0;
        group.chips.forEach((chip, c) => {
          const splitW = splitWidths[g][c];
          const share = group.chips.length === 1 ? joinedGroupW : joinedGroupW / group.chips.length;
          placed.push({
            token: chip,
            joinedX: joinedGroupX + withinJoined,
            joinedW: share,
            splitX: splitCursor,
            splitW,
            groupIndex: g,
          });
          withinJoined += share;
          splitCursor += splitW + chipGap;
        });
        splitCursor += groupGap - chipGap;
      });

      // ---- phase mixes -------------------------------------------------------
      const splitMix = easeInOut(clamp01(t - 1)); // 0 = joined words, 1 = chips
      const embedMix = clamp01(t - 2); // token tiles paint in
      const poolMix = easeInOut(clamp01(t - 3)); // tiles converge into one
      const normMix = easeInOut(clamp01(t - 4)); // length set to 1
      const flyMix = easeInOut(clamp01(t - 5)); // the vector leaves for the cloud

      const tileSize = Math.max(
        14,
        Math.min(52, (bandWidth - 40) / Math.max(1, placed.length) - 8)
      );
      const tileH = tileSize * (TILE_ROWS / TILE_COLS) * 0.62;
      const chipY = centreY - tileH / 2 - 34;
      const tileY = centreY - tileH / 2 + 8;

      // ---- the paper band ----------------------------------------------------
      const bandPad = 26;
      const bandTop = chipY - bandPad - 14;
      const bandBottom = tileY + tileH + bandPad + 26;
      context.globalAlpha = filmAlpha * 0.94 * (1 - flyMix * 0.85);
      context.fillStyle = PAPER;
      roundRect(context, availableLeft, bandTop, bandWidth, bandBottom - bandTop, 3);
      context.fill();
      context.strokeStyle = BORDER;
      context.lineWidth = 1;
      context.stroke();

      // ---- the operation, named ---------------------------------------------
      // Keyed off the stage, not the continuous timeline: scrubbing parks
      // `progress` at 1, which pushes `t` onto the next stage's boundary and
      // would name the operation after the one that has not started yet.
      const operationLabel = OPERATION_LABELS[stage] ?? OPERATION_LABELS[OPERATION_LABELS.length - 1];

      context.globalAlpha = filmAlpha * (1 - flyMix);
      context.font = '500 10.5px "DM Mono", ui-monospace, monospace';
      context.textBaseline = "middle";
      context.textAlign = "left";
      context.fillStyle = ACCENT;
      context.fillText(operationLabel, availableLeft + 16, bandTop + 16);

      if (tokenVectorsTruncated && t >= 2) {
        context.fillStyle = MUTED;
        context.textAlign = "right";
        context.fillText("first 64 tokens shown", availableRight - 16, bandTop + 16);
        context.textAlign = "left";
      }

      // ---- chips -------------------------------------------------------------
      const chipH = 24;
      context.textBaseline = "middle";
      placed.forEach((entry, i) => {
        const isSpecial = entry.token.special;
        // Stagger the split left to right so you watch each word come apart
        // rather than the whole line snapping at once.
        const stagger = clamp01(
          (splitMix * (placed.length + 6) - entry.groupIndex) / 3
        );
        const mix = easeInOut(stagger);

        const x = lerp(entry.joinedX, entry.splitX, mix);
        const width = lerp(entry.joinedW || entry.splitW, entry.splitW, mix);
        const alpha = isSpecial ? mix : 1;
        // Chips recede once their numbers exist — the tiles are the subject now.
        const fade = 1 - poolMix * 0.85;

        context.globalAlpha = filmAlpha * alpha * fade * (1 - flyMix);
        if (mix > 0.02) {
          context.fillStyle = isSpecial ? "#f1ece2" : entry.token.continuation ? "#f4e6e2" : PAPER;
          roundRect(context, x, chipY - chipH / 2, Math.max(2, width), chipH, 2);
          context.fill();
          context.strokeStyle = BORDER;
          context.lineWidth = 1;
          context.stroke();
        }

        context.font = mix > 0.5 ? '500 13px "DM Mono", ui-monospace, monospace' : '400 15px "DM Serif Display", Georgia, serif';
        context.fillStyle = isSpecial ? MUTED : entry.token.continuation ? ACCENT : INK;
        context.textAlign = "center";
        // Below half-split the word still reads as a word; above it, as pieces.
        const label =
          mix > 0.5
            ? entry.token.text
            : entry.token.continuation
              ? entry.token.text.replace(/^##/, "")
              : entry.token.text;
        context.fillText(label, x + Math.max(2, width) / 2, chipY);
      });

      // ---- token tiles: each token becoming real numbers ---------------------
      const meanX = centreX - tileSize / 2;
      placed.forEach((entry, i) => {
        const tile = tiles[i];
        if (!tile) return;
        // Paint in one token at a time, in reading order.
        const appear = clamp01((embedMix * (placed.length + 4) - i) / 2.2);
        if (appear <= 0) return;

        const x = lerp(entry.splitX + entry.splitW / 2 - tileSize / 2, meanX, poolMix);
        const scale = lerp(0.55, 1, easeOut(appear));
        // They converge and dissolve; the mean tile rises in their place.
        context.globalAlpha = filmAlpha * appear * (1 - poolMix) * (1 - flyMix);
        context.imageSmoothingEnabled = false;
        context.drawImage(
          tile,
          x + (tileSize * (1 - scale)) / 2,
          tileY + (tileH * (1 - scale)) / 2,
          tileSize * scale,
          tileH * scale
        );
      });

      // ---- the mean, then the mean at unit length ----------------------------
      const resultTile = normMix > 0.5 ? finalTile : meanTile;
      if (resultTile && poolMix > 0) {
        const flyTarget = screenRef.current.query;
        const targetX = flyTarget ? flyTarget.sx : centreX;
        const targetY = flyTarget ? flyTarget.sy : centreY;
        const scale = lerp(1, 0.06, flyMix);
        const x = lerp(meanX, targetX - (tileSize * scale) / 2, flyMix);
        const y = lerp(tileY, targetY - (tileH * scale) / 2, flyMix);

        context.globalAlpha = filmAlpha * poolMix;
        context.imageSmoothingEnabled = false;
        context.drawImage(resultTile, x, y, tileSize * scale, tileH * scale);

        // Length readout: the one thing normalisation visibly changes, since
        // scaling a vector cannot change the pattern above it.
        if (normMix > 0 && flyMix < 0.6) {
          const length = lerp(meanNorm, 1, normMix);
          context.globalAlpha = filmAlpha * normMix * (1 - flyMix);
          context.font = '500 11px "DM Mono", ui-monospace, monospace';
          context.fillStyle = INK;
          context.textAlign = "center";
          context.fillText(
            `‖v‖ = ${length.toFixed(3)}`,
            centreX,
            tileY + tileH + 18
          );
          context.fillStyle = MUTED;
          context.font = '400 10.5px "DM Mono", ui-monospace, monospace';
          context.fillText(
            "direction kept · length set to 1",
            centreX,
            tileY + tileH + 34
          );
        }
      }

      // ---- counts, so the arithmetic is checkable ---------------------------
      if (poolMix > 0.05 && flyMix < 0.8) {
        context.globalAlpha = filmAlpha * poolMix * (1 - flyMix);
        context.font = '400 10.5px "DM Mono", ui-monospace, monospace';
        context.fillStyle = MUTED;
        context.textAlign = "center";
        context.fillText(
          `${placed.length} token vectors → 1 · averaged position by position`,
          centreX,
          bandTop + 34
        );
      }

      context.restore();
      context.globalAlpha = 1;
      context.textAlign = "left";
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [
    groups,
    tiles,
    meanTile,
    finalTile,
    meanNorm,
    stage,
    playing,
    screenRef,
    leftInset,
    rightInset,
    topInset,
    bottomInset,
    tokenVectorsTruncated,
  ]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", display: "block" }}
    />
  );
}
