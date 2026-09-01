"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { project } from "@/lib/viz/projection";
import { createTokenizer, type WordPieceConfig } from "@/lib/viz/wordpiece";
import type { LookupDebug, PlacedSynset, Run, Snapshot } from "./types";
import { EMPTY_RUN } from "./types";

/** Runs one real search for /explain and works out where to draw the answers. */
// It calls the same API the app calls, so every score shown is a live one, and
// it places results with the same function that placed the background cloud, so
// a result lands exactly where it belongs rather than near its neighbours.

const SNAPSHOT_URL = "/viz/pipeline-snapshot.json";
const WORDPIECE_URL = "/viz/wordpiece.json";

/** How many meanings to ask for; the list shows the best ten. */
export const SHORTLIST_K = 10;

type Assets = { snapshot: Snapshot; tokenize: ReturnType<typeof createTokenizer> } | null;

/** Shared, so the large background file downloads once per page, not per run. */
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
  // Forget a failed download, or every later attempt fails instantly with the
  // same stale error.
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

      // Stop a slow answer from overwriting a newer one.
      const id = ++requestId.current;
      const { snapshot, tokenize } = assets;

      // Split the phrase here and show it at once. It really is the split the
      // server is about to use, and it costs no waiting.
      const { tokens, truncated } = tokenize(trimmed);
      setRun({ ...EMPTY_RUN, phase: "searching", query: trimmed, tokens, truncated });

      try {
        const response = await fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmed, k: SHORTLIST_K, debug: true }),
        });

        // Read the body first, then check the status: an empty body otherwise
        // throws a confusing parse error that hides what really went wrong.
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
