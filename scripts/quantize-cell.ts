/**
 * Quantize an existing cell to IEEE binary16 — the precision pgvector's
 * `halfvec` stores — and optionally truncate it to fewer dimensions.
 *
 * NO RE-EMBEDDING. This rewrites bytes already computed, so the only thing it
 * can measure is what storage precision costs. That is exactly the question:
 * `halfvec` halves the index, and the storage arithmetic for the production
 * cutover only works if it is free.
 *
 * TWO SEPARATE LOSSY STEPS, DELIBERATELY NOT CONFLATED.
 *
 *   --precision half   rounds each component to binary16. Both the documents
 *                      and the query carry the error, because a halfvec column
 *                      casts the query too. Expected to be nearly free: the
 *                      relative error is ~1e-3 and cosine averages over 384
 *                      dimensions.
 *
 *   --dims <n>         keeps only the first n components. This is TRUNCATION,
 *                      not quantization, and it is a much stronger claim. It is
 *                      free only for a model trained with Matryoshka
 *                      representation learning, where the leading dimensions are
 *                      deliberately made sufficient on their own. Neither model
 *                      here was: `all-MiniLM-L6-v2` and the fine-tune derived
 *                      from it emit 384 dimensions that carry no such ordering,
 *                      so the leading 256 are just an arbitrary two-thirds of an
 *                      entangled representation. Measure it before believing any
 *                      size figure that assumes it.
 *
 * Vectors are renormalised after each step so a dot product remains a true
 * cosine, matching what `<=>` computes over the stored values.
 *
 *   npx tsx scripts/quantize-cell.ts --from eval_gloss_ft --precision half
 *   npx tsx scripts/quantize-cell.ts --from eval_gloss_ft --precision half --dims 256
 */
import path from "node:path";
import { DIM, cellDir, loadIndex, writeIndex, type CellMeta } from "./lib/localIndex";
import { bytesSha256 } from "./lib/cellText";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function main(): void {
  const from = arg("--from");
  if (!from) {
    console.error("usage: --from <cell> [--precision half|float] [--dims <n>] [--out <cell>]");
    process.exitCode = 1;
    return;
  }
  const half = (arg("--precision") ?? "half") === "half";
  const dims = Number(arg("--dims") ?? DIM);
  if (!Number.isInteger(dims) || dims < 1 || dims > DIM) {
    console.error(`--dims must be an integer in 1..${DIM}`);
    process.exitCode = 1;
    return;
  }
  const out = arg("--out") ?? `${from}_${half ? "h" : "f"}${dims}`;

  const src = loadIndex(from);
  if (src.meta.dim !== DIM) {
    console.error(`${from} is ${src.meta.dim}-dim; quantize from a full-width cell.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Source cell   ${from}`);
  console.log(`  model       ${src.meta.model}`);
  console.log(`  variant     ${src.meta.variant}   scale ${src.meta.scale ?? "sampled"}`);
  console.log(`  rows        ${src.meta.rows.toLocaleString()} x ${src.meta.dim}`);
  console.log(`\nTarget        ${out}`);
  console.log(`  precision   ${half ? "float16 (halfvec)" : "float32"}`);
  console.log(`  dims        ${dims}${dims < DIM ? `  *** TRUNCATED from ${DIM} ***` : ""}`);

  const rows = src.meta.rows;
  const outVec = new Float32Array(rows * dims);
  const scratch = new Float16Array(dims);

  // Largest per-component and per-vector deviations, so the report can say how
  // much the representation actually moved rather than asserting it is small.
  let maxComponentErr = 0;
  let minCos = 1;
  let sumCos = 0;

  for (let i = 0; i < rows; i++) {
    const off = i * DIM;
    const cut = new Float32Array(dims);
    for (let j = 0; j < dims; j++) cut[j] = src.data[off + j];

    // Renormalise after truncation so the retained subspace is a unit sphere.
    let n = 0;
    for (let j = 0; j < dims; j++) n += cut[j] * cut[j];
    n = Math.sqrt(n) || 1;
    for (let j = 0; j < dims; j++) cut[j] /= n;

    let quantized = cut;
    if (half) {
      scratch.set(cut);
      quantized = new Float32Array(scratch);
      for (let j = 0; j < dims; j++) {
        const e = Math.abs(quantized[j] - cut[j]);
        if (e > maxComponentErr) maxComponentErr = e;
      }
      let qn = 0;
      for (let j = 0; j < dims; j++) qn += quantized[j] * quantized[j];
      qn = Math.sqrt(qn) || 1;
      for (let j = 0; j < dims; j++) quantized[j] /= qn;

      // Cosine between the vector before and after rounding: how far the
      // quantized point moved on the sphere.
      let dot = 0;
      for (let j = 0; j < dims; j++) dot += quantized[j] * cut[j];
      sumCos += dot;
      if (dot < minCos) minCos = dot;
    }
    outVec.set(quantized, i * dims);
  }

  if (half) {
    console.log(`\n  quantization error`);
    console.log(`    max component deviation   ${maxComponentErr.toExponential(3)}`);
    console.log(`    cos(before, after)  mean  ${(sumCos / rows).toFixed(8)}   min ${minCos.toFixed(8)}`);
    console.log(
      `    A vector that barely moves can still change a RANKING when neighbours\n` +
        `    are packed tightly, which is why this is measured on the eval set and\n` +
        `    not argued from the error bound.`
    );
  }

  const meta: Omit<CellMeta, "dim" | "rows" | "distinctWords" | "builtAt"> = {
    ...src.meta,
    cell: out,
    precision: half ? "float16" : "float32",
    sourceCell: from,
    inputsSha256: src.meta.inputsSha256,
    vectorsSha256: bytesSha256(
      Buffer.from(outVec.buffer, outVec.byteOffset, outVec.byteLength)
    ),
    note:
      `${half ? "binary16 (halfvec) quantization" : "float32 copy"}` +
      `${dims < DIM ? ` + TRUNCATION to the leading ${dims} of ${DIM} dims` : ""}` +
      ` of ${from}. No re-embedding. ` +
      (dims < DIM
        ? `Truncation is only free for a Matryoshka-trained encoder; ${src.meta.model} is not one, ` +
          `so this cell measures how much the leading ${dims} dims actually carry. `
        : "") +
      `Source pool: ${src.meta.note}`,
  };

  const written = writeIndex(meta, outVec, cellDir(), dims);
  const bytesOnDisk = (rows * dims * (half ? 2 : 4)) / 1e6;
  console.log(`\n  wrote ${path.basename(written.vec)}`);
  console.log(
    `  as a Postgres column this is ${bytesOnDisk.toFixed(0)} MB of vector payload ` +
      `(${rows.toLocaleString()} x ${dims} x ${half ? 2 : 4} bytes)`
  );
  console.log(`  (the local .vec stays float32 for speed; the VALUES are the quantized ones)\n`);
}

main();
