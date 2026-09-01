"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlacedSynset, Snapshot } from "./types";

// The 3D view: a cloud of meanings, the query arriving in it, and the results
// lighting up. Drawn by hand rather than with a 3D library, which would have
// been a large dependency for a small job in an app that has five in total.
//
// The picture keeps only a fraction of the real detail. Distances on screen are
// not the ranking and are never used as one — every score shown on this page
// was computed by the database across all 384 numbers.

export type CloudTheme = {
  background: string;
  point: string;
  pointAlpha: number;
  hit: string;
  query: string;
  label: string;
  labelHalo: string;
  link: string;
  axis: string;
};

export const PAPER_THEME: CloudTheme = {
  background: "#faf7f2",
  point: "#211d19",
  pointAlpha: 0.3,
  hit: "#7a2e2e",
  query: "#7a2e2e",
  label: "#211d19",
  labelHalo: "#faf7f2",
  link: "#7a2e2e",
  axis: "#e2dbcd",
};

export const PLATE_THEME: CloudTheme = {
  background: "#211d19",
  point: "#faf7f2",
  pointAlpha: 0.42,
  hit: "#e88b6a",
  query: "#f4e6e2",
  label: "#faf7f2",
  labelHalo: "#211d19",
  link: "#e88b6a",
  axis: "#3f3a34",
};

/** Where things ended up on screen this frame, for the animation to aim at. */
// Held outside React on purpose: sending 60 updates a second through it would
// redraw the whole page for nothing.
export type ScreenRef = { query: { sx: number; sy: number } | null };

type Props = {
  snapshot: Snapshot;
  synsets: PlacedSynset[];
  queryPoint: { x: number; y: number; z: number } | null;
  /** Draw links from the query to each hit — the "nearest senses" moment. */
  showLinks?: boolean;
  /** Fade the cloud back so the hits read first. */
  emphasiseHits?: boolean;
  theme?: CloudTheme;
  /** Written each frame with the query's projected screen position. */
  screenRef?: React.MutableRefObject<ScreenRef>;
  /** Suppress the query marker while the film still has custody of it. */
  hideQueryMarker?: boolean;
  /** Lift the orbit controls clear of whatever chrome sits at the bottom. */
  controlsBottom?: number;
  className?: string;
  style?: React.CSSProperties;
};

type Camera = { theta: number; phi: number; radius: number; tx: number; ty: number; tz: number };

const HOME: Camera = { theta: 0.9, phi: 0.42, radius: 2.1, tx: 0, ty: 0, tz: 0 };
const MIN_RADIUS = 0.55;
const MAX_RADIUS = 5.5;
const FLIGHT_MS = 900;
const HOVER_RADIUS_PX = 9;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type Rect = { x: number; y: number; w: number; h: number };

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Put a label near its point without overlapping one already placed. */
// Tries four sides, then gives up rather than stack text on text. The list
// beside the picture carries every name anyway.
function placeLabel(
  sx: number,
  sy: number,
  width: number,
  height: number,
  taken: Rect[],
  bounds: { w: number; h: number }
): Rect | null {
  const gap = 9;
  const candidates: Rect[] = [
    { x: sx + gap, y: sy - height / 2, w: width, h: height },
    { x: sx - gap - width, y: sy - height / 2, w: width, h: height },
    { x: sx - width / 2, y: sy - gap - height, w: width, h: height },
    { x: sx - width / 2, y: sy + gap, w: width, h: height },
  ];

  for (const rect of candidates) {
    if (rect.x < 2 || rect.y < 2 || rect.x + rect.w > bounds.w - 2 || rect.y + rect.h > bounds.h - 2) {
      continue;
    }
    if (taken.some((other) => overlaps(rect, other))) continue;
    return rect;
  }
  return null;
}

/** Shortest-way-round interpolation, so a flight never spins the long way. */
function lerpAngle(a: number, b: number, t: number): number {
  let delta = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

export default function PointCloud({
  snapshot,
  synsets,
  queryPoint,
  showLinks = false,
  emphasiseHits = false,
  theme = PAPER_THEME,
  screenRef,
  hideQueryMarker = false,
  controlsBottom = 12,
  className,
  style,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const camera = useRef<Camera>({ ...HOME });
  const flight = useRef<{ from: Camera; to: Camera; started: number } | null>(null);
  const drift = useRef(true);
  const dirty = useRef(true);
  const pointer = useRef<{ x: number; y: number; dragging: boolean; moved: boolean }>({
    x: 0,
    y: 0,
    dragging: false,
    moved: false,
  });
  const screen = useRef<Float32Array>(new Float32Array(0));
  /** What the cursor is over. Kept outside React for the drawing, inside it for the text. */
  // Otherwise every mouse movement tears down and rebuilds the drawing loop.
  const hoverRef = useRef<number | null>(null);
  const [hoverRow, setHoverRow] = useState<number | null>(null);

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

  const hitRows = useMemo(() => new Set(synsets.map((s) => s.cloudRow).filter((r): r is number => r !== null)), [synsets]);

  const flyTo = useCallback((to: Partial<Camera>) => {
    const target: Camera = { ...camera.current, ...to };
    if (reducedMotion.current) {
      camera.current = target;
      dirty.current = true;
      return;
    }
    flight.current = { from: { ...camera.current }, to: target, started: performance.now() };
  }, []);

  const goHome = useCallback(() => {
    drift.current = true;
    flyTo({ ...HOME });
  }, [flyTo]);

  // When a query lands, frame it: centre on the query and pull in enough to see
  // the hits around it.
  useEffect(() => {
    if (!queryPoint) return;
    drift.current = false;
    let reach = 0;
    for (const s of synsets) {
      reach = Math.max(
        reach,
        Math.hypot(s.x - queryPoint.x, s.y - queryPoint.y, s.z - queryPoint.z)
      );
    }
    flyTo({
      tx: queryPoint.x,
      ty: queryPoint.y,
      tz: queryPoint.z,
      radius: Math.min(MAX_RADIUS, Math.max(0.9, reach * 3.1)),
      theta: HOME.theta + 0.55,
      phi: 0.3,
    });
  }, [queryPoint, synsets, flyTo]);

  useEffect(() => {
    dirty.current = true;
  }, [showLinks, emphasiseHits, theme, synsets, hideQueryMarker]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let raf = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = wrap.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty.current = true;
    };

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();

    const n = snapshot.keys.length;
    if (screen.current.length !== n * 3) screen.current = new Float32Array(n * 3);
    const order = new Int32Array(n);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);

      if (flight.current) {
        const { from, to, started } = flight.current;
        const t = Math.min(1, (now - started) / FLIGHT_MS);
        const e = easeInOut(t);
        camera.current = {
          theta: lerpAngle(from.theta, to.theta, e),
          phi: lerp(from.phi, to.phi, e),
          radius: lerp(from.radius, to.radius, e),
          tx: lerp(from.tx, to.tx, e),
          ty: lerp(from.ty, to.ty, e),
          tz: lerp(from.tz, to.tz, e),
        };
        if (t >= 1) flight.current = null;
        dirty.current = true;
      } else if (drift.current && !pointer.current.dragging && !reducedMotion.current) {
        // A slow idle turn so the cloud reads as three-dimensional at a glance.
        camera.current.theta += 0.0012;
        dirty.current = true;
      }

      if (!dirty.current) return;
      dirty.current = false;

      const cam = camera.current;
      const cx = width / 2;
      const cy = height / 2;
      const focal = Math.min(width, height) * 0.95;

      // Camera basis.
      const cp = Math.cos(cam.phi);
      const ex = cam.tx + cam.radius * cp * Math.cos(cam.theta);
      const ey = cam.ty + cam.radius * Math.sin(cam.phi);
      const ez = cam.tz + cam.radius * cp * Math.sin(cam.theta);

      let fx = cam.tx - ex;
      let fy = cam.ty - ey;
      let fz = cam.tz - ez;
      const flen = Math.hypot(fx, fy, fz) || 1;
      fx /= flen;
      fy /= flen;
      fz /= flen;

      // right = forward x worldUp, then up = right x forward.
      let rx = fz;
      let ry = 0;
      let rz = -fx;
      const rlen = Math.hypot(rx, ry, rz) || 1;
      rx /= rlen;
      ry /= rlen;
      rz /= rlen;
      const ux = ry * fz - rz * fy;
      const uy = rz * fx - rx * fz;
      const uz = rx * fy - ry * fx;

      const projectPoint = (px: number, py: number, pz: number) => {
        const dx = px - ex;
        const dy = py - ey;
        const dz = pz - ez;
        const depth = dx * fx + dy * fy + dz * fz;
        if (depth <= 0.05) return null;
        const vx = dx * rx + dy * ry + dz * rz;
        const vy = dx * ux + dy * uy + dz * uz;
        return { sx: cx + (vx / depth) * focal, sy: cy - (vy / depth) * focal, depth };
      };

      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, width, height);

      // Transform the cloud.
      const buf = screen.current;
      let visible = 0;
      for (let i = 0; i < n; i++) {
        const p = projectPoint(snapshot.x[i], snapshot.y[i], snapshot.z[i]);
        if (!p || p.sx < -40 || p.sy < -40 || p.sx > width + 40 || p.sy > height + 40) {
          buf[i * 3 + 2] = -1;
          continue;
        }
        buf[i * 3] = p.sx;
        buf[i * 3 + 1] = p.sy;
        buf[i * 3 + 2] = p.depth;
        order[visible++] = i;
      }

      // Painter's algorithm: far first, so near points sit on top.
      const slice = order.subarray(0, visible);
      Array.prototype.sort.call(slice, (a: number, b: number) => buf[b * 3 + 2] - buf[a * 3 + 2]);

      const near = Math.max(0.15, cam.radius * 0.35);
      const far = cam.radius * 2.1;
      const cloudAlpha = emphasiseHits ? theme.pointAlpha * 0.42 : theme.pointAlpha;

      ctx.fillStyle = theme.point;
      for (let k = 0; k < visible; k++) {
        const i = slice[k];
        if (hitRows.has(i)) continue;
        const depth = buf[i * 3 + 2];
        // Nearer points are larger and darker — the only sense of depth a flat
        // picture gets.
        const t = Math.min(1, Math.max(0, (depth - near) / (far - near)));
        ctx.globalAlpha = cloudAlpha * (1 - t * 0.78);
        const r = 1.9 - t * 1.15;
        ctx.beginPath();
        ctx.arc(buf[i * 3], buf[i * 3 + 1], Math.max(0.45, r), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const qp = queryPoint ? projectPoint(queryPoint.x, queryPoint.y, queryPoint.z) : null;
      if (screenRef) {
        screenRef.current.query = qp ? { sx: qp.sx, sy: qp.sy } : null;
      }

      // Links from the query out to each retrieved sense.
      if (showLinks && qp) {
        ctx.strokeStyle = theme.link;
        ctx.lineWidth = 1;
        for (const s of synsets) {
          const p = projectPoint(s.x, s.y, s.z);
          if (!p) continue;
          ctx.globalAlpha = 0.34 - s.rank * 0.022;
          ctx.beginPath();
          ctx.moveTo(qp.sx, qp.sy);
          ctx.lineTo(p.sx, p.sy);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Retrieved senses, nearest last so rank 1 is never occluded.
      const placed = synsets
        .map((s) => ({ s, p: projectPoint(s.x, s.y, s.z) }))
        .filter((entry): entry is { s: PlacedSynset; p: NonNullable<ReturnType<typeof projectPoint>> } => entry.p !== null)
        .sort((a, b) => b.p.depth - a.p.depth);

      ctx.font = '500 11px "DM Mono", ui-monospace, monospace';
      ctx.textBaseline = "middle";

      // All the dots first, then labels on top, so a label can be dropped for
      // lack of room without losing the dot it names.
      for (const { s, p } of placed) {
        ctx.fillStyle = theme.hit;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, s.rank === 0 ? 5 : 3.4, 0, Math.PI * 2);
        ctx.fill();
      }

      const taken: Rect[] = [];
      const bounds = { w: width, h: height };
      const labelHeight = 13;

      const drawLabel = (sx: number, sy: number, text: string, bold: boolean) => {
        ctx.font = `${bold ? 600 : 500} 11px "DM Mono", ui-monospace, monospace`;
        const rect = placeLabel(sx, sy, ctx.measureText(text).width + 4, labelHeight, taken, bounds);
        if (!rect) return;
        taken.push(rect);
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = theme.labelHalo;
        ctx.strokeText(text, rect.x + 2, rect.y + labelHeight / 2);
        ctx.fillStyle = theme.label;
        ctx.fillText(text, rect.x + 2, rect.y + labelHeight / 2);
      };

      // The query is a diamond, never mistaken for a result, and gets first
      // claim on label space since it must always be findable.
      if (qp && !hideQueryMarker) {
        const size = 7;
        ctx.save();
        ctx.translate(qp.sx, qp.sy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = theme.query;
        ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.restore();
        drawLabel(qp.sx, qp.sy, "your description", true);
      }

      // Then the hits, best-ranked first so ties for space go to rank 1.
      for (const { s, p } of [...placed].sort((a, b) => a.s.rank - b.s.rank)) {
        if (s.rank >= 5) continue;
        drawLabel(p.sx, p.sy, `${s.lemmas[0]} · ${s.similarity.toFixed(3)}`, s.rank === 0);
      }

      // Whatever the cursor is over, drawn last and always — it was asked for.
      const hovered = hoverRef.current;
      if (hovered !== null && buf[hovered * 3 + 2] > 0) {
        const hx = buf[hovered * 3];
        const hy = buf[hovered * 3 + 1];
        ctx.fillStyle = theme.hit;
        ctx.beginPath();
        ctx.arc(hx, hy, 4, 0, Math.PI * 2);
        ctx.fill();
        const label = snapshot.lemmas[hovered].join(", ");
        ctx.font = '600 11px "DM Mono", ui-monospace, monospace';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = theme.labelHalo;
        ctx.strokeText(label, hx + 9, hy - 1);
        ctx.fillStyle = theme.label;
        ctx.fillText(label, hx + 9, hy - 1);
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [snapshot, synsets, queryPoint, showLinks, emphasiseHits, theme, hitRows, screenRef, hideQueryMarker]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    pointer.current = { x: event.clientX, y: event.clientY, dragging: true, moved: false };
    drift.current = false;
    flight.current = null;
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current.dragging) {
      const dx = event.clientX - pointer.current.x;
      const dy = event.clientY - pointer.current.y;
      pointer.current.x = event.clientX;
      pointer.current.y = event.clientY;
      pointer.current.moved = true;
      camera.current.theta -= dx * 0.006;
      camera.current.phi = Math.max(-1.45, Math.min(1.45, camera.current.phi + dy * 0.006));
      dirty.current = true;
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const buf = screen.current;
    let best = -1;
    let bestDist = HOVER_RADIUS_PX;
    for (let i = 0; i < snapshot.keys.length; i++) {
      if (buf[i * 3 + 2] <= 0) continue;
      const d = Math.hypot(buf[i * 3] - mx, buf[i * 3 + 1] - my);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    const next = best === -1 ? null : best;
    if (hoverRef.current !== next) {
      hoverRef.current = next;
      setHoverRow(next);
    }
    dirty.current = true;
  };

  const endDrag = () => {
    pointer.current.dragging = false;
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    camera.current.radius = Math.max(
      MIN_RADIUS,
      Math.min(MAX_RADIUS, camera.current.radius * (1 + event.deltaY * 0.0011))
    );
    drift.current = false;
    dirty.current = true;
  };

  return (
    <div ref={wrapRef} className={className} style={{ position: "relative", ...style }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={() => {
          endDrag();
          hoverRef.current = null;
          setHoverRow(null);
        }}
        onWheel={onWheel}
        style={{ display: "block", touchAction: "none", cursor: pointer.current.dragging ? "grabbing" : "grab" }}
        aria-label={`A projection of ${snapshot.sampled.toLocaleString()} word senses into three dimensions. Drag to orbit, scroll to zoom. The ranked results are also listed as text below.`}
        role="img"
      />

      <div
        style={{
          position: "absolute",
          left: 12,
          bottom: controlsBottom,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={goHome}
          className="font-mono"
          style={{
            fontSize: 11,
            padding: "5px 10px",
            border: `1px solid ${theme.axis}`,
            background: theme.background,
            color: theme.label,
            borderRadius: 2,
            cursor: "pointer",
          }}
        >
          ⌂ home view
        </button>
        <span className="font-mono" style={{ fontSize: 10.5, color: theme.label, opacity: 0.6 }}>
          drag to orbit · scroll to zoom
        </span>
      </div>

      {hoverRow !== null && (
        <div
          className="font-mono"
          style={{
            position: "absolute",
            left: 12,
            top: 12,
            right: 12,
            fontSize: 11,
            lineHeight: 1.5,
            color: theme.label,
            opacity: 0.85,
            pointerEvents: "none",
          }}
        >
          <b>{snapshot.lemmas[hoverRow].join(", ")}</b> — {snapshot.glosses[hoverRow]}
        </div>
      )}
    </div>
  );
}
