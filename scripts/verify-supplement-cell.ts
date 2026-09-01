/**
 * Integrity check for the assembled experiment files.
 *
 * The other checker rebuilds its fingerprint from the original dictionary alone,
 * so it would rightly reject a file that also holds added entries. Same
 * criteria, different source of truth: the record written alongside each file.
 *
 *   1. Fingerprint. Recompute it from the recorded texts and compare. Proves
 *      row 5 holds the text row 5 claims, in the order the numbers were written.
 *
 *   2. Unchanged front. The original rows must be byte-for-byte identical to the
 *      verified control. The entire argument for these files is that the
 *      original half was copied rather than re-measured, so any difference is
 *      the added rows alone. That is an assumption until something compares the
 *      bytes, and this is that something.
 *
 *   3. Can it find itself? Measure a row's own text and require that row back
 *      first. Sampled from each half separately, because a build that misaligned
 *      only the added half would still pass a sample drawn from the front.
 *
 *      Not a perfect score, and that is expected: some definitions appear word
 *      for word under more than one entry, in both halves. Those are genuinely
 *      indistinguishable, and neither is a defect.
 *
 *   npx tsx scripts/verify-supplement-cell.ts
 *   npx tsx scripts/verify-supplement-cell.ts full_gloss_wikt_new
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { embedWith } from "./lib/embedModel";
import { inputsSha256 } from "./lib/cellText";
import { cellDir, loadIndex, searchLocalRows, vocabularyOf, DIM } from "./lib/localIndex";

const BASE_CELL = "full_gloss_ft";
const BASE_ROWS = 117_791;
/** Checks per half, kept equal so neither can hide behind the other's score. */
const SAMPLE_PER_HALF = 30;
const PASS_THRESHOLD = 27; // of 30, per half — same 5% collision allowance as RD-16

type ManifestRow = { key: string; word: string; text: string; source: string };

function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function readManifest(file: string): Promise<ManifestRow[]> {
  const rows: ManifestRow[] = [];
  const stream = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of stream) if (line) rows.push(JSON.parse(line) as ManifestRow);
  return rows;
}

/** Compare the start of two files byte by byte, without loading either whole. */
function prefixIdentical(a: string, b: string, rows: number): boolean {
  const bytes = rows * DIM * 4;
  if (fs.statSync(b).size < bytes) return false;
  const fdA = fs.openSync(a, "r");
  const fdB = fs.openSync(b, "r");
  try {
    const chunk = 1 << 22;
    const bufA = Buffer.alloc(chunk);
    const bufB = Buffer.alloc(chunk);
    for (let off = 0; off < bytes; off += chunk) {
      const want = Math.min(chunk, bytes - off);
      fs.readSync(fdA, bufA, 0, want, off);
      fs.readSync(fdB, bufB, 0, want, off);
      if (!bufA.subarray(0, want).equals(bufB.subarray(0, want))) return false;
    }
    return true;
  } finally {
    fs.closeSync(fdA);
    fs.closeSync(fdB);
  }
}

async function verify(cell: string, dir: string): Promise<boolean> {
  const idx = loadIndex(cell, dir);
  const manifestFile = path.join(dir, `${cell}.manifest.jsonl`);

  console.log(`  ${cell}`);
  console.log(
    `    ${idx.meta.rows.toLocaleString()} rows x ${idx.meta.dim}d   ${idx.meta.model}   ` +
      `vocabulary: ${vocabularyOf(idx.meta)}` +
      (idx.meta.supplementArm ? `   arm: ${idx.meta.supplementArm}` : "")
  );

  if (!fs.existsSync(manifestFile)) {
    console.log(`    *** no ${path.basename(manifestFile)} — cannot verify a composed cell without it\n`);
    return false;
  }

  const manifest = await readManifest(manifestFile);
  let ok = true;

  // 1 — input hash
  if (manifest.length !== idx.meta.rows) {
    console.log(`    *** manifest has ${manifest.length} rows, cell has ${idx.meta.rows}`);
    ok = false;
  }
  const hash = inputsSha256(manifest.map((r) => r.text));
  if (hash === idx.meta.inputsSha256) {
    console.log(`    input hash      OK`);
  } else {
    console.log(
      `    *** INPUT HASH MISMATCH — the cell does not index the text the manifest claims.\n` +
        `        Rebuild it. A stale cell wins or loses on content, not on vocabulary, and\n` +
        `        nothing downstream would reveal that.`
    );
    ok = false;
  }

  // 2 — prefix identity against the control
  const basePath = path.join(dir, `${BASE_CELL}.vec`);
  const cellPath = path.join(dir, `${cell}.vec`);
  if (!fs.existsSync(basePath)) {
    console.log(`    prefix identity SKIPPED — no ${BASE_CELL}.vec to compare against`);
  } else if (prefixIdentical(basePath, cellPath, BASE_ROWS)) {
    console.log(
      `    prefix identity OK — first ${BASE_ROWS.toLocaleString()} rows byte-identical to ${BASE_CELL}`
    );
  } else {
    console.log(
      `    *** PREFIX DIFFERS from ${BASE_CELL}. The WordNet half was NOT copied verbatim, so a\n` +
        `        delta against the control confounds the added rows with a re-encode. Do not score it.`
    );
    ok = false;
  }

  // 3 — self-retrieval, both halves
  const halves: { label: string; from: number; to: number }[] = [
    { label: "wordnet", from: 0, to: BASE_ROWS },
    { label: "wiktionary", from: BASE_ROWS, to: manifest.length },
  ];
  const rand = rng(17);
  for (const half of halves) {
    const span = half.to - half.from;
    if (span <= 0) continue;
    let pass = 0;
    const misses: string[] = [];
    for (let s = 0; s < SAMPLE_PER_HALF; s++) {
      const i = half.from + Math.floor(rand() * span);
      const vector = await embedWith(idx.meta.model, manifest[i].text);
      const hits = searchLocalRows(idx, vector, 5);
      if (hits[0]?.senseKey === manifest[i].key) pass++;
      else if (misses.length < 3) {
        misses.push(`${manifest[i].word} [${manifest[i].key}] -> ${hits[0]?.word} [${hits[0]?.senseKey}]`);
      }
    }
    const good = pass >= PASS_THRESHOLD;
    if (!good) ok = false;
    console.log(
      `    self-retrieval  ${half.label.padEnd(10)} key at rank 1: ${pass}/${SAMPLE_PER_HALF}   ` +
        `${good ? "OK" : `*** BELOW ${PASS_THRESHOLD}/${SAMPLE_PER_HALF} — vectors and keys are misaligned ***`}`
    );
    for (const m of misses) console.log(`      MISS: ${m}`);
  }

  console.log("");
  return ok;
}

async function main(): Promise<void> {
  const dir = cellDir();
  const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const cells = named.length
    ? named
    : fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".manifest.jsonl"))
        .map((f) => f.replace(/\.manifest\.jsonl$/, ""))
        .sort();

  if (!cells.length) {
    console.error(`no composed cells in ${dir} (looked for *.manifest.jsonl)`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nRD-17 · composed cell verification   ${dir}\n`);
  let failed = 0;
  for (const cell of cells) if (!(await verify(cell, dir))) failed++;

  console.log(
    `  Criterion: input hash exact, first ${BASE_ROWS.toLocaleString()} rows byte-identical to\n` +
      `  ${BASE_CELL}, and ${PASS_THRESHOLD}-${SAMPLE_PER_HALF}/${SAMPLE_PER_HALF} self-retrieval in EACH half. Not ${SAMPLE_PER_HALF}/${SAMPLE_PER_HALF}: 482 WordNet gloss\n` +
      `  texts are shared by more than one synset, and Wiktionary repeats glosses across\n` +
      `  homographs, so a few probes are genuinely indistinguishable rather than wrong.\n`
  );
  if (failed) {
    console.log(`  ${failed} cell(s) FAILED.\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
