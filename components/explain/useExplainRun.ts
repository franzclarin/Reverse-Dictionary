"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { project } from "@/lib/viz/projection";
import { createTokenizer, type WordPieceConfig } from "@/lib/viz/wordpiece";
import type { LookupDebug, PlacedSynset, Run, Snapshot } from "./types";
import { EMPTY_RUN } from "./types";

/**
 * Drives one pass of the real pipeline for /explain.
 *
 * Two things here are load-bearing for the page not being a lie:
 *
 *  1. It calls the SAME `/api/lookup` the app calls, with `debug: true`. Every
 *     similarity shown therefore comes from the live 693,325-sense index
 *     through the served code path — there is no second retrieval implementation
 *     to drift from it.
 *  2. It places retrieved synsets with `project()`, the same function the build
 *     script placed the cloud with, applied to the vector the API returned. A
 *     synset absent from the sampled cloud still lands exactly where it belongs
 *     rather than being interpolated from its neighbours.
 */

const SNAPSHOT_URL = "/viz/pipeline-snapshot.json";
const WORDPIECE_URL = "/viz/wordpiece.json";

/** Synsets requested. The API caps k at 100; the ranked list shows the top 10. */
export const SHORTLIST_K = 10;

type Assets = { snapshot: Snapshot; tokenize: ReturnType<typeof createTokenizer> } | null;

/**
 * Module-level, so the 800 KB snapshot is fetched once per page rather than
 * once per effect run. React StrictMode double-invokes effects in development,
 * and without this that is 1.6 MB of duplicate downloads on every reload.
 */
let assetsPromise: Promise<NonNullable<Assets>> | null = null;

function loadAssets(): Promise<NonNullable<Assets>> {
  if (assetsPromise) return assetsPromise;
  assetsPromise = (async () => {
    const [snapRes, wpRes] = await Promise.all([fetch(SNAPSHOT_URL), fetch(WORDPIECE_URL)]);
    if (!snapRes.ok || !wpRes.ok) {
      throw new Error("the /explain assets are missing — run `npm run build-viz` to generate them");
    }
    const snapshot = (await snapRes.json()) as Snapshot;
    const config = (await wpRes.json()) as WordPieceConfig;
    return { snapshot, tokenize: createTokenizer(config) };
  })();
  // Never cache a rejected promise: a transient failure would otherwise make
  // every later mount fail instantly with the same stale error. Same rule
  // lib/embedder.ts follows for the model loader.
  assetsPromise.catch(() => {
    assetsPromise = null;
  });
  return assetsPromise;
}

export function useExplainRun() {
  const [assets, setAssets] = useState<Assets>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [run, setRun] = useState<Run>(EMPTY_RUN);
  const requestId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadAssets();
        if (cancelled) return;
        setAssets(loaded);
      } catch (error) {
        if (!cancelled) setAssetError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const search = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (!assets || !trimmed) return;

      // Guard against an out-of-order response overwriting a newer one, the same
      // way components/SearchResults.tsx does.
      const id = ++requestId.current;
      const { snapshot, tokenize } = assets;

      // Tokenize locally and show it immediately: this is genuinely the split the
      // server is about to feed the encoder, and it costs no round trip.
      const { tokens, truncated } = tokenize(trimmed);
      setRun({ ...EMPTY_RUN, phase: "searching", query: trimmed, tokens, truncated });

      try {
        const response = await fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmed, k: SHORTLIST_K, debug: true }),
        });

        // Parse first, THEN check ok: an empty body from a gateway error
        // otherwise throws "Unexpected end of JSON input" and hides the status.
        let payload: {
          results?: { word: string; similarity: number }[];
          timingMs?: number;
          debug?: LookupDebug;
          error?: string;
          detail?: string;
        };
        try {
          payload = await response.json();
        } catch {
          throw new Error(`the server returned an empty response (HTTP ${response.status})`);
        }
        if (!response.ok) throw new Error(payload.detail || payload.error || `HTTP ${response.status}`);
        if (!payload.debug) throw new Error("the server returned no debug payload");
        if (id !== requestId.current) return;

        const debug = payload.debug;
        const cloudRows = new Map<string, number>();
        snapshot.keys.forEach((key, i) => cloudRows.set(key, i));

        const synsets: PlacedSynset[] = debug.synsets.map((synset, rank) => {
          const point = project(synset.vector, snapshot.basis, snapshot.mean);
          return {
            ...synset,
            rank,
            ...point,
            cloudRow: cloudRows.get(synset.synsetKey) ?? null,
          };
        });

        setRun({
          phase: "done",
          query: trimmed,
          tokens,
          truncated,
          queryVector: debug.queryVector,
          tokenVectors: debug.tokenVectors ?? [],
          tokenVectorsTruncated: debug.tokenVectorsTruncated ?? false,
          queryPoint: project(debug.queryVector, snapshot.basis, snapshot.mean),
          synsets,
          results: payload.results ?? [],
          timingMs: payload.timingMs ?? 0,
          probes: debug.probes,
          lists: debug.lists,
          error: null,
        });
      } catch (error) {
        if (id !== requestId.current) return;
        setRun((previous) => ({
          ...previous,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [assets]
  );

  return { assets, assetError, run, search, ready: assets !== null };
}
