// Experiment indexes kept as plain files instead of in the database.
//
// Two benefits beyond staying out of the way: the experiments write nothing to
// the real database, and searching a file checks every row, so results measure
// the idea being tested with no index shortcuts mixed in.
//
// Each experiment is two files: the raw numbers, and a description of them.
// They live outside the repo by default, since they are large and derived.
// Override the location with EVAL_CELL_DIR.
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
  /** How big a pool this was built from. Different sizes aren't comparable —
   *  fewer wrong answers to sift is simply an easier task. */
  scale?: "sampled" | "full";
  /** Which dictionaries the rows come from. Tracked separately from size,
   *  because two experiments can be the same size and still hold different
   *  candidates, which makes their scores just as incomparable. */
  vocabulary?: "wordnet" | "wordnet+wiktionary";
  /** Which variant produced the extra half, if there is one. */
  supplementArm?: string;
  /** Which version of the filter was used, if extra entries are present. */
  filterVersion?: string;
  poolWords?: number;
  /** Fingerprints of what went in and what came out, so a stale or
   *  half-written file can be caught rather than argued about. */
  inputsSha256?: string;
  vectorsSha256?: string;
  /** How precisely the numbers are stored, so rounding can be tested the way
   *  the database would do it. Storing fewer numbers is a different and far
   *  lossier step, tracked separately on purpose. */
  precision?: "float32" | "float16";
  sourceCell?: string;
  dim: number;
  rows: number;
  distinctWords: number;
  builtAt: string;
  note: string;
  words: string[];
  senseKeys?: string[];
  /** Which words belong to each meaning, since the answer key is a word. */
  synsetMembers?: Record<string, string[]>;
};

export function scaleOf(meta: CellMeta): "sampled" | "full" {
  return meta.scale ?? "sampled";
}

/** Which dictionaries an experiment holds. Older files say nothing, and for
 *  those the honest reading is the original single source. */
export function vocabularyOf(meta: CellMeta): "wordnet" | "wordnet+wiktionary" {
  return meta.vocabulary ?? "wordnet";
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

/** Takes either an experiment's name or a path to one of its files. */
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

/** Put the question through the same treatment the stored entries got. */
// Whatever was done to the entries — dropping numbers, or rounding them — has
// to happen to the question too, or the cost of doing it looks smaller than it
// really is. Rescaling at the end is what keeps the comparison exact.
export function prepareQuery(meta: CellMeta, vector: number[]): number[] {
  let v = vector.length === meta.dim ? vector.slice() : vector.slice(0, meta.dim);
  if (meta.precision === "float16") v = Array.from(new Float32Array(new Float16Array(v)));
  const norm = Math.hypot(...v);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

/** How to break ties, without peeking at the answer key. */
// Identical scores are normal here, since words sharing a meaning share their
// numbers exactly. Alphabetical order settles it: repeatable, and unrelated to
// both where a row sits in the file and where the right answers were put. A tie
// the search genuinely cannot break should be settled by something that knows
// nothing, not by something that knows where the answers are.
export function compareWord(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type LocalRowHit = {
  row: number;
  word: string;
  senseKey?: string;
  similarity: number;
};

/** Search without merging duplicates, so the caller sees which row won. */
// The integrity check needs this. Synonyms share identical numbers, so asking
// "did the exact word win?" only measures how ties were broken. Asking "did a
// row from the right meaning win?" is the question that actually matters.
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

/** Search by meaning, then expand each result into its words. */
// The answer key is a single word, so results have to be words. When the search
// genuinely cannot tell two synonyms apart, the commoner one is the better bet.
// One meaning can fill several result slots, so these scores are not
// interchangeable with the one-row-per-meaning kind and are reported apart.
export type ExpandOrder = (key: string, members: string[]) => string[];

export function searchLocalSynsets(
  index: LocalIndex,
  query: number[],
  k: number,
  expand: ExpandOrder
): ResultRow[] {
  const members = index.meta.synsetMembers ?? {};
  // Every meaning yields at least one word, so k meanings yield at least k words.
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

/** Check every row, so the result is exactly right rather than nearly right. */
// `perSense` keeps each word's best meaning instead of blending them together.
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
