"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type SoundName = "key" | "return" | "stamp" | "error" | "click";

const STORAGE_KEY = "rd-sound-enabled";

interface SoundContextType {
  enabled: boolean;
  toggle: () => void;
  play: (name: SoundName) => void;
}

const SoundContext = createContext<SoundContextType>({
  enabled: true,
  toggle: () => {},
  play: () => {},
});

// Kept outside React: browsers limit how many of these a page may create, so
// it has to survive re-renders.
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  // Browsers keep sound paused until the user interacts with the page.
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

function noiseBurst(
  ctx: AudioContext,
  { duration, gain, filterType, filterFreq, q = 1 }: {
    duration: number;
    gain: number;
    filterType: BiquadFilterType;
    filterFreq: number;
    q?: number;
  }
) {
  const now = ctx.currentTime;
  const bufferSize = Math.max(1, Math.ceil(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  filter.Q.value = q;

  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(gain, now);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  source.connect(filter).connect(gainNode).connect(ctx.destination);
  source.start(now);
  source.stop(now + duration);
}

/** A typewriter key strike. Pitch varies so fast typing doesn't sound robotic. */
function playKey(ctx: AudioContext, variant: number) {
  noiseBurst(ctx, {
    duration: 0.03,
    gain: 0.14,
    filterType: "bandpass",
    filterFreq: 2200 + variant * 260,
    q: 1.2,
  });
}

/** Bell-like ding — a typewriter carriage return, on submit. */
function playReturn(ctx: AudioContext) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(1760, now);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.12, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.45);
}

/** A rubber stamp landing, when results arrive. */
function playStamp(ctx: AudioContext) {
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(55, now + 0.12);

  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.22, now);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

  osc.connect(oscGain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.16);

  noiseBurst(ctx, { duration: 0.02, gain: 0.18, filterType: "lowpass", filterFreq: 900 });
}

/** Two soft falling notes for no match or an error. Deliberately not alarming. */
function playError(ctx: AudioContext) {
  const now = ctx.currentTime;
  [440, 349.23].forEach((freq, i) => {
    const start = now + i * 0.11;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.09, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);

    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.18);
  });
}

/** A small click for minor actions, like "Load more" or copying a link. */
function playClick(ctx: AudioContext) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(900, now);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.05, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);

  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.04);
}

/** Smallest gap between repeats of a sound, so held keys don't turn into a buzz. */
const MIN_GAP_MS: Record<SoundName, number> = {
  key: 35,
  return: 200,
  stamp: 200,
  error: 200,
  click: 60,
};

export function SoundProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(true);
  const keyVariant = useRef(0);
  const lastPlayed = useRef<Partial<Record<SoundName, number>>>({});

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) setEnabled(stored === "true");
    } catch {
      /* localStorage unavailable (private mode, disabled storage) — default stands */
    }
  }, []);

  const play = useCallback(
    (name: SoundName) => {
      if (!enabled) return;
      const ctx = getAudioContext();
      if (!ctx) return;

      const now = performance.now();
      if (now - (lastPlayed.current[name] ?? 0) < MIN_GAP_MS[name]) return;
      lastPlayed.current[name] = now;

      switch (name) {
        case "key":
          keyVariant.current = (keyVariant.current + 1) % 4;
          playKey(ctx, keyVariant.current);
          break;
        case "return":
          playReturn(ctx);
          break;
        case "stamp":
          playStamp(ctx);
          break;
        case "error":
          playError(ctx);
          break;
        case "click":
          playClick(ctx);
          break;
      }
    },
    [enabled]
  );

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        /* best-effort persistence only */
      }
      if (next) {
        const ctx = getAudioContext();
        if (ctx) playClick(ctx);
      }
      return next;
    });
  }, []);

  return (
    <SoundContext.Provider value={{ enabled, toggle, play }}>{children}</SoundContext.Provider>
  );
}

export const useSound = () => useContext(SoundContext);
