import type { Basis } from "@/lib/viz/projection";
import type { Token } from "@/lib/viz/wordpiece";

/** The saved background cloud, built by `scripts/build-viz-snapshot.ts`. */
export type Snapshot = {
  builtAt: string;
  dim: number;
  /** How many meanings are in the real index. The cloud shows a sample of them. */
  indexRows: number;
  sampled: number;
  /** How much of the real detail the flattened picture keeps. Must be displayed. */
  varianceExplained: number;
  componentVariance: number[];
  spread95: number[];
  basis: Basis;
  mean: number[];
  keys: string[];
  /** Part of speech per point: noun, verb, adjective, adverb. */
  pos: string;
  lemmas: string[][];
  glosses: string[];
  x: number[];
  y: number[];
  z: number[];
};

/** The extra working-out the search API returns when asked for it. */
export type LookupDebug = {
  queryVector: number[];
  /** The real numbers for each word-part, before they were averaged. */
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

/** A result with its position, worked out exactly rather than from its neighbours. */
export type PlacedSynset = LookupDebug["synsets"][number] & {
  rank: number;
  x: number;
  y: number;
  z: number;
  /** Its place in the background cloud, when it happens to be drawn there too. */
  cloudRow: number | null;
};

export type RunPhase = "idle" | "tokenizing" | "searching" | "done" | "error";

export type Run = {
  phase: RunPhase;
  query: string;
  tokens: Token[];
  truncated: boolean;
  /** The query's real numbers, as the server worked them out. */
  queryVector: number[] | null;
  /** The real numbers per word-part. The animation averages these on screen. */
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
