/**
 * Build the static snapshot the /explain page draws its cloud from (RD-18).
 *
 * Emits `public/viz/pipeline-snapshot.json`: a fixed 384x3 PCA basis, the mean
 * vector it centres on, and a stratified sample of synsets already projected
 * through that basis. The page ships this file and projects live query vectors
 * through the same matrix, so a retrieved synset absent from the sample still
 * lands at its exact position — the property UMAP and t-SNE cannot offer, and
 * the reason RD-18 specified PCA.
 *
 * Read-only against the database. Nothing here touches the search path.
 *
 * The sample is a deterministic stride over `id` (`id % stride = 0`) rather
 * than `ORDER BY random()`: reproducible without depending on Postgres's RNG
 * seeding, and because ids follow WordNet's own offset order it spreads evenly
 * across parts of speech instead of clumping.
 *
 * `varianceExplained` is MEASURED here and must be displayed on the page. An
 * unlabelled projection invites the viewer to read distances off the picture,
 * which is the one lesson this page exists to prevent.
 *
 *   npx tsx scripts/build-viz-snapshot.ts [--sample 6000] [--out <path>]
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { GLOSS_INDEX } from "../lib/glossSearch";
import { VIZ_DIM, parseVectorLiteral, type Basis } from "../lib/viz/projection";

loadEnv();

const prisma = new PrismaClient();
const OUT_PATH = path.resolve(process.cwd(), "public/viz/pipeline-snapshot.json");

/** Points in the drawn cloud. Trades payload size against how full it looks. */
const DEFAULT_SAMPLE = 6000;

/** Power-iteration budget per component. Converges long before this. */
const MAX_POWER_ITERATIONS = 500;
const CONVERGENCE_EPS = 1e-10;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function numArg(flag: string, fallback: number): number {
  const v = arg(flag);
  return v === undefined ? fallback : Number(v);
}

type Row = {
  synsetKey: string;
  pos: string;
  gloss: string;
  lemmas: string[];
  v: string;
};

async function loadSample(sampleSize: number): Promise<Row[]> {
  const countRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM "${GLOSS_INDEX}"`
  );
  const total = Number(countRows[0].n);
  const stride = Math.max(1, Math.floor(total / sampleSize));

  console.log(`  index rows      ${total.toLocaleString()}`);
  console.log(`  stride          every ${stride}th row (deterministic)`);

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT "synsetKey", "pos", "gloss", "lemmas", embedding::text AS v
       FROM "${GLOSS_INDEX}"
      WHERE id % $1 = 0
      ORDER BY id`,
    stride
  );

  console.log(`  sampled         ${rows.length.toLocaleString()} synsets`);
  return rows;
}

/**
 * Fit three principal components by power iteration with deflation.
 *
 * Rolled by hand rather than pulling a numeric dependency: the covariance is
 * only 384x384 and three components converge in a few hundred cheap iterations.
 * The starting vector is deterministic (not `Math.random`) so two runs of this
 * script produce a byte-identical basis — which matters, because the committed
 * snapshot and any future rebuild have to place points the same way.
 */
function fitPca(
  vectors: Float64Array,
  rows: number,
  dim: number
): { basis: Basis; mean: number[]; eigenvalues: number[]; totalVariance: number } {
  // Mean.
  const mean = new Float64Array(dim);
  for (let r = 0; r < rows; r++) {
    const off = r * dim;
    for (let j = 0; j < dim; j++) mean[j] += vectors[off + j];
  }
  for (let j = 0; j < dim; j++) mean[j] /= rows;

  // Centre in place.
  for (let r = 0; r < rows; r++) {
    const off = r * dim;
    for (let j = 0; j < dim; j++) vectors[off + j] -= mean[j];
  }

  // Covariance, upper triangle then mirrored.
  const cov = new Float64Array(dim * dim);
  for (let r = 0; r < rows; r++) {
    const off = r * dim;
    for (let i = 0; i < dim; i++) {
      const xi = vectors[off + i];
      if (xi === 0) continue;
      const rowOff = i * dim;
      for (let j = i; j < dim; j++) cov[rowOff + j] += xi * vectors[off + j];
    }
  }
  const denom = rows - 1;
  for (let i = 0; i < dim; i++) {
    for (let j = i; j < dim; j++) {
      const value = cov[i * dim + j] / denom;
      cov[i * dim + j] = value;
      cov[j * dim + i] = value;
    }
  }

  let totalVariance = 0;
  for (let i = 0; i < dim; i++) totalVariance += cov[i * dim + i];

  const basis: number[][] = [];
  const eigenvalues: number[] = [];
  const v = new Float64Array(dim);
  const next = new Float64Array(dim);

  for (let component = 0; component < 3; component++) {
    // Deterministic, non-degenerate start; sin() is not orthogonal to anything
    // in particular, which is exactly what a starting vector wants to be.
    for (let i = 0; i < dim; i++) v[i] = Math.sin(i + 1 + component * 977);
    normalise(v);

    let eigenvalue = 0;
    for (let iter = 0; iter < MAX_POWER_ITERATIONS; iter++) {
      for (let i = 0; i < dim; i++) {
        const rowOff = i * dim;
        let acc = 0;
        for (let j = 0; j < dim; j++) acc += cov[rowOff + j] * v[j];
        next[i] = acc;
      }
      const norm = normalise(next);
      let delta = 0;
      for (let i = 0; i < dim; i++) delta += Math.abs(next[i] - v[i]);
      v.set(next);
      if (Math.abs(norm - eigenvalue) < CONVERGENCE_EPS && delta < CONVERGENCE_EPS) {
        eigenvalue = norm;
        break;
      }
      eigenvalue = norm;
    }

    // Rayleigh quotient — the honest eigenvalue for the converged vector.
    let lambda = 0;
    for (let i = 0; i < dim; i++) {
      const rowOff = i * dim;
      let acc = 0;
      for (let j = 0; j < dim; j++) acc += cov[rowOff + j] * v[j];
      lambda += v[i] * acc;
    }

    basis.push(Array.from(v));
    eigenvalues.push(lambda);

    // Deflate so the next iteration cannot rediscover this direction.
    for (let i = 0; i < dim; i++) {
      const rowOff = i * dim;
      const vi = v[i];
      for (let j = 0; j < dim; j++) cov[rowOff + j] -= lambda * vi * v[j];
    }
  }

  return { basis, mean: Array.from(mean), eigenvalues, totalVariance };
}

function normalise(v: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return norm;
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

async function main() {
  const sampleSize = numArg("--sample", DEFAULT_SAMPLE);
  const outPath = arg("--out") ? path.resolve(process.cwd(), arg("--out")!) : OUT_PATH;

  console.log("\nRD-18 · viz snapshot\n");
  const rows = await loadSample(sampleSize);
  if (rows.length === 0) throw new Error("no rows sampled — is GlossEmbedding populated?");

  const dim = VIZ_DIM;
  const flat = new Float64Array(rows.length * dim);
  rows.forEach((row, r) => {
    const vec = parseVectorLiteral(row.v);
    if (vec.length !== dim) {
      throw new Error(`${row.synsetKey}: expected ${dim} dims, got ${vec.length}`);
    }
    flat.set(vec, r * dim);
  });

  console.log("\n  fitting PCA (power iteration, 3 components)…");
  const started = Date.now();
  // NB: fitPca centres `flat` IN PLACE, so it holds centred vectors afterwards.
  const { basis, mean, eigenvalues, totalVariance } = fitPca(flat, rows.length, dim);
  console.log(`  fitted in       ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // Orthogonality is the check that deflation actually worked.
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += basis[a][i] * basis[b][i];
      if (Math.abs(dot) > 1e-6) {
        throw new Error(`components ${a} and ${b} are not orthogonal (dot=${dot})`);
      }
    }
  }

  const componentShare = eigenvalues.map((l) => l / totalVariance);
  const varianceExplained = componentShare.reduce((a, b) => a + b, 0);
  console.log(
    `  variance        PC1 ${(componentShare[0] * 100).toFixed(1)}%  ` +
      `PC2 ${(componentShare[1] * 100).toFixed(1)}%  ` +
      `PC3 ${(componentShare[2] * 100).toFixed(1)}%  ` +
      `= ${(varianceExplained * 100).toFixed(1)}% of 384-d variance`
  );

  // Project. `flat` is already centred, so this is a plain dot product — the
  // same arithmetic `project()` performs after subtracting the mean.
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let r = 0; r < rows.length; r++) {
    const off = r * dim;
    const coords = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const axis = basis[c];
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += flat[off + i] * axis[i];
      coords[c] = dot;
    }
    xs.push(round(coords[0], 4));
    ys.push(round(coords[1], 4));
    zs.push(round(coords[2], 4));
  }

  const spread = [xs, ys, zs].map((axis) => {
    const sorted = [...axis].map(Math.abs).sort((a, b) => a - b);
    return round(sorted[Math.floor(sorted.length * 0.95)], 4);
  });

  const snapshot = {
    builtAt: new Date().toISOString(),
    note:
      "RD-18 · PCA basis + sampled synset cloud for /explain. Every coordinate " +
      "here is a projection of a real stored embedding; 3D distance is NOT the " +
      "ranking, which is cosine similarity over all 384 dimensions.",
    dim,
    indexRows: Number(
      (await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${GLOSS_INDEX}"`))[0].n
    ),
    sampled: rows.length,
    varianceExplained: round(varianceExplained, 6),
    componentVariance: componentShare.map((s) => round(s, 6)),
    totalVariance: round(totalVariance, 8),
    spread95: spread,
    basis: basis.map((axis) => axis.map((v) => round(v, 6))),
    mean: mean.map((v) => round(v, 6)),
    keys: rows.map((r) => r.synsetKey),
    // One character per point, in point order: n/v/a/r.
    pos: rows.map((r) => r.pos[0]).join(""),
    lemmas: rows.map((r) => r.lemmas),
    glosses: rows.map((r) => r.gloss),
    x: xs,
    y: ys,
    z: zs,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot), "utf8");
  const bytes = fs.statSync(outPath).size;
  console.log(
    `\n  wrote ${path.relative(process.cwd(), outPath)} (${(bytes / 1e6).toFixed(2)} MB)\n`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
