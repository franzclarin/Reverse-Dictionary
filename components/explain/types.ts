import type { Basis } from "@/lib/viz/projection";
import type { Token } from "@/lib/viz/wordpiece";

/** `public/viz/pipeline-snapshot.json`, built by `scripts/build-viz-snapshot.ts`. */
export type Snapshot = {
  builtAt: string;
  dim: number;
  /** Rows in the live index — 117,791. The cloud is a sample of it, not all of it. */
  indexRows: number;
  sampled: number;
  /** Share of 384-d variance the three drawn components carry. MUST be displayed. */
  varianceExplained: number;
  componentVariance: number[];
  spread95: number[];
  basis: Basis;
  mean: number[];
  keys: string[];
  /** One char per point, in point order: n / v / a / r. */
  pos: string;
  lemmas: string[][];
  glosses: string[];
  x: number[];
  y: number[];
  z: number[];
};

/** The `debug` block `/api/lookup` returns for `{ debug: true }`. */
export type LookupDebug = {
  queryVector: number[];
  /** The real per-token vectors the query vector was pooled from. */
  tokenVectors: number[][];
  tokenVectorsTruncated: boolean;
  synsets: {
    synsetKey: string;
    gloss: string;
    lemmas: string[];
    similarity: number;
    vector: number[];
  }[];
  probes: number;
  lists: number;
};

export type ResultRow = { word: string; similarity: number };

/** A retrieved synset, placed. `x/y/z` come from `project()`, never from neighbours. */
export type PlacedSynset = LookupDebug["synsets"][number] & {
  rank: number;
  x: number;
  y: number;
  z: number;
  /** Row in the sampled cloud, when this synset happens to be drawn there too. */
  cloudRow: number | null;
};

export type RunPhase = "idle" | "tokenizing" | "searching" | "done" | "error";

export type Run = {
  phase: RunPhase;
  query: string;
  tokens: Token[];
  truncated: boolean;
  /** The query's real 384 numbers, as the server computed them. */
  queryVector: number[] | null;
  /** One real vector per token, in token order. The film averages these on screen. */
  tokenVectors: number[][];
  tokenVectorsTruncated: boolean;
  queryPoint: { x: number; y: number; z: number } | null;
  synsets: PlacedSynset[];
  results: ResultRow[];
  timingMs: number;
  probes: number;
  lists: number;
  error: string | null;
};

export const EMPTY_RUN: Run = {
  phase: "idle",
  query: "",
  tokens: [],
  truncated: false,
  queryVector: null,
  tokenVectors: [],
  tokenVectorsTruncated: false,
  queryPoint: null,
  synsets: [],
  results: [],
  timingMs: 0,
  probes: 0,
  lists: 0,
  error: null,
};
