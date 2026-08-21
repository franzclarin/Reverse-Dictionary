/**
 * File-backed vector indexes for the Phase E 2x2.
 *
 * WHY NOT POSTGRES. The Neon project has a 512 MB size limit and
 * `VocabEmbedding` plus its IVFFlat index already occupies 451 MB of it. There
 * is no room for ~100k experiment vectors, and making room would mean touching
 * production data. Storing the sampled pool locally sidesteps that entirely and
 * has two side benefits: the experiment performs no database writes at all, and
 * a brute-force scan over the pool is *exact* by construction, so the 2x2
 * measures representation with no approximate-index effect mixed in.
 *
 * Format, per cell:
 *   <cell>.vec   raw little-endian Float32, n * dim, no header
 *   <cell>.json  { cell, model, variant, dim, words[], senseKeys[]? }
 *
 * Vectors are L2-normalised on the way in (the sentence-transformers Normalize
 * layer), so cosine similarity is a plain dot product.
 *
 * Files live outside the repo by default: this working tree is inside OneDrive,
 * which would try to sync ~230 MB of derived data. Override with EVAL_CELL_DIR.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResultRow } from "./retrieval";

export const DIM = 384;

export function cellDir(): string {
  if (process.env.EVAL_CELL_DIR) return process.env.EVAL_CELL_DIR;
  return process.platform === "win32"
    ? "C:/Temp/rd_eval_cells"
    : path.join(os.tmpdir(), "rd_eval_cells");
}

export type CellMeta = {
  cell: string;
  model: string;
  variant: string;
  representation: "lemma" | "gloss";
  /**
   * Which pool this cell was built from. Optional only because cells written
   * before the full-scale rebuild predate the field; `scaleOf()` treats those
   * as sampled. Cells of different scale are not comparable — fewer distractors
   * is a strictly easier task — and the tooling flags rather than merges them.
   */
  scale?: "sampled" | "full";
  poolWords?: number;
  /**
   * SHA256 of the ordered input text list this cell was built from, and of the
   * vector file's raw bytes. Optional only because cells written before the
   * concurrent-write incident predate the fields. `verify-eval-pool.ts`
   * recomputes the first from the manifest and treats a mismatch as stale.
   */
  inputsSha256?: string;
  vectorsSha256?: string;
  /**
   * Storage precision of the vectors on disk. `float16` cells hold values that
   * have been rounded to IEEE binary16 and written back as float32 — the same
   * values pgvector's `halfvec` would store, so the recall they produce is the
   * recall a halfvec column produces. `dim` below may also be shorter than the
   * encoder's native width: that is TRUNCATION, a separate and much larger
   * lossy step, not part of quantization. Kept distinct on purpose.
   */
  precision?: "float32" | "float16";
  sourceCell?: string;
  dim: number;
  rows: number;
  distinctWords: number;
  builtAt: string;
  note: string;
  words: string[];
  senseKeys?: string[];
  /**
   * Synset cells only: synset key -> the words that belong to it. A row is a
   * synset, so retrieval must expand it into member words before anything can
   * be scored against a word-level answer key.
   */
  synsetMembers?: Record<string, string[]>;
};

export function scaleOf(meta: CellMeta): "sampled" | "full" {
  return meta.scale ?? "sampled";
}

export type LocalIndex = {
  meta: CellMeta;
  data: Float32Array;
};

function paths(cell: string, dir = cellDir()): { vec: string; json: string } {
  return { vec: path.join(dir, `${cell}.vec`), json: path.join(dir, `${cell}.json`) };
}

export function writeIndex(
  meta: Omit<CellMeta, "dim" | "rows" | "distinctWords" | "builtAt">,
  vectors: Float32Array,
  dir = cellDir(),
  dim = DIM
): { vec: string; json: string; bytes: number } {
  fs.mkdirSync(dir, { recursive: true });
  const { vec, json } = paths(meta.cell, dir);

  const rows = meta.words.length;
  if (vectors.length !== rows * dim) {
    throw new Error(
      `vector buffer is ${vectors.length} floats, expected ${rows * dim} (${rows} x ${dim})`
    );
  }

  fs.writeFileSync(vec, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  const full: CellMeta = {
    ...meta,
    dim,
    rows,
    distinctWords: new Set(meta.words).size,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(json, JSON.stringify(full), "utf8");
  return { vec, json, bytes: vectors.byteLength };
}

/** Accepts a cell name or a path to its .json / .vec. */
export function loadIndex(ref: string, dir = cellDir()): LocalIndex {
  const cell = path.basename(ref).replace(/\.(json|vec)$/, "");
  const base = ref.includes("/") || ref.includes("\\") ? path.dirname(ref) : dir;
  const { vec, json } = paths(cell, base);

  if (!fs.existsSync(json) || !fs.existsSync(vec)) {
    throw new Error(`no local index "${cell}" in ${base} (looked for ${json})`);
  }

  const meta = JSON.parse(fs.readFileSync(json, "utf8")) as CellMeta;
  const buf = fs.readFileSync(vec);
  const data = new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  );
  if (data.length !== meta.rows * meta.dim) {
    throw new Error(`${cell}: vector file has ${data.length} floats, metadata says ${meta.rows * meta.dim}`);
  }
  return { meta, data };
}

/**
 * Put a query vector into the same space as a cell's stored vectors.
 *
 * Every step here mirrors something the database would do to a query against
 * the corresponding column, and each is applied ONLY if the cell says so:
 *
 *   truncate   `halfvec(256)` over a 384-dim encoder means the query is
 *              truncated too. Renormalising after the cut makes the dot product
 *              a true cosine over the surviving subspace, which is what pgvector
 *              computes with `<=>`.
 *   quantize   a `halfvec` column casts the query to halfvec before comparing,
 *              so BOTH sides carry the rounding error. Quantizing only the
 *              documents would understate the cost.
 *
 * The final renormalisation is what lets the search stay a plain dot product:
 * `cos(a,b) = (a/|a|)·(b/|b|)`, so pre-dividing both sides reproduces `<=>`
 * exactly rather than approximately.
 */
export function prepareQuery(meta: CellMeta, vector: number[]): number[] {
  let v = vector.length === meta.dim ? vector.slice() : vector.slice(0, meta.dim);
  if (meta.precision === "float16") v = Array.from(new Float32Array(new Float16Array(v)));
  const norm = Math.hypot(...v);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

/**
 * Deterministic, answer-key-independent tie order.
 *
 * Equal scores are common and structural here: every word in a WordNet synset
 * shares one gloss, so a gloss cell holds bit-identical vectors for all of them
 * and something has to decide which surfaces first. Whatever decides it must not
 * correlate with row position — that is the general vulnerability that made the
 * pool's target-first layout exploitable (METHODS.md §12), and it is fixed here
 * independently so a future pool change cannot reopen it silently.
 *
 * Alphabetical on the word: deterministic, reproducible, and unrelated to both
 * row position and the answer key. It is arbitrary with respect to quality —
 * that is the point. A tie the retrieval genuinely cannot break should be
 * decided by something that knows nothing, not by something that knows where
 * the targets were written.
 */
export function compareWord(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type LocalRowHit = {
  row: number;
  word: string;
  senseKey?: string;
  similarity: number;
};

/**
 * Row-level search: no per-word dedupe, so the caller can see WHICH row won.
 *
 * Needed by the integrity check. A WordNet synset has one gloss shared by all
 * its words, so a gloss cell stores that identical text once per synonym —
 * identical vectors, and which synonym lands at rank 1 is an arbitrary
 * tie-break. Asking "did the exact lemma win?" therefore measures tie-breaking,
 * not correctness; asking "did a row from the right synset win?" measures
 * whether vectors and words are still aligned, which is the actual question.
 */
export function searchLocalRows(
  index: LocalIndex,
  query: number[],
  k = 10
): LocalRowHit[] {
  const { meta, data } = index;
  const { rows, dim, words, senseKeys } = meta;
  const scores = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    const off = i * dim;
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += data[off + j] * query[j];
    scores[i] = dot;
  }
  return Array.from({ length: rows }, (_, i) => i)
    .sort(
      (a, b) =>
        scores[b] - scores[a] ||
        compareWord(words[a], words[b]) ||
        compareWord(senseKeys?.[a] ?? "", senseKeys?.[b] ?? "")
    )
    .slice(0, k)
    .map((i) => ({ row: i, word: words[i], senseKey: senseKeys?.[i], similarity: scores[i] }));
}

/**
 * Search a synset-keyed cell and expand each hit into its member words.
 *
 * A row here is a synset, but the answer key is a single word, so the results
 * have to be words. Members are emitted in `order` (descending Zipf in the
 * harness): if the retrieval cannot distinguish `bungle` from `botch` — and it
 * cannot, their vectors are identical — the commoner word is the better guess.
 *
 * NOTE THE SCORING SURFACE. One retrieved synset can occupy several top-k
 * slots, so a 24-member synset at rank 1 fills the entire top 10 by itself.
 * That makes these numbers structurally different from a per-sense gloss cell's,
 * which is why this cell is reported separately and never substituted into the
 * 2x2.
 */
export type ExpandOrder = (key: string, members: string[]) => string[];

export function searchLocalSynsets(
  index: LocalIndex,
  query: number[],
  k: number,
  expand: ExpandOrder
): ResultRow[] {
  const members = index.meta.synsetMembers ?? {};
  // Each synset yields at least one word, so k synsets always yield >= k words.
  const hits = searchLocalRows(index, query, k);
  const out: ResultRow[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const key = hit.senseKey ?? "";
    const words = expand(key, members[key] ?? [hit.word]);
    for (const word of words) {
      if (seen.has(word)) continue;
      seen.add(word);
      out.push({ word, similarity: hit.similarity });
      if (out.length >= k) return out;
    }
  }
  return out;
}

/**
 * Exhaustive nearest-neighbour search. Exact by construction.
 *
 * `perSense` collapses to one row per word keeping its best-matching sense —
 * a single averaged vector represents no sense of a polysemous word well,
 * which is half the reason for indexing senses separately.
 */
export function searchLocal(
  index: LocalIndex,
  query: number[],
  options: { k?: number; perSense?: boolean } = {}
): ResultRow[] {
  const { k = 10, perSense = false } = options;
  const { meta, data } = index;
  const { rows, dim, words } = meta;

  const scores = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    const off = i * dim;
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += data[off + j] * query[j];
    scores[i] = dot;
  }

  if (!perSense) {
    const order = Array.from({ length: rows }, (_, i) => i).sort(
      (a, b) => scores[b] - scores[a] || compareWord(words[a], words[b])
    );
    return order.slice(0, k).map((i) => ({ word: words[i], similarity: scores[i] }));
  }

  const best = new Map<string, number>();
  for (let i = 0; i < rows; i++) {
    const word = words[i];
    const current = best.get(word);
    if (current === undefined || scores[i] > current) best.set(word, scores[i]);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || compareWord(a[0], b[0]))
    .slice(0, k)
    .map(([word, similarity]) => ({ word, similarity }));
}
