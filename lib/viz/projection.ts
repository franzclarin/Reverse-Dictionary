/**
 * The 384 -> 3 projection used by the /explain page.
 *
 * Deliberately dependency-free and imported by BOTH sides:
 * `scripts/build-viz-snapshot.ts` places the sampled cloud with it, and the
 * browser places the live query and every retrieved synset with it. One code
 * path, so a returned synset lands at its true position rather than at a
 * position invented to look right.
 *
 * This is why RD-18 chose PCA over UMAP/t-SNE. PCA is *parametric*: the fit
 * produces a fixed 384x3 matrix, so a vector the fit never saw still has an
 * exact place in the picture, and the layout does not move between queries.
 *
 * WHAT THIS DOES NOT DO: preserve distance. Three components carry a modest
 * share of the variance in 384 dimensions (the measured figure is recorded in
 * the snapshot as `varianceExplained` and MUST be shown on screen). Ranking is
 * cosine similarity over all 384 dimensions and is never read off these
 * coordinates.
 */

export const VIZ_DIM = 384;

/** Row-major 3 x 384: three orthonormal principal components. */
export type Basis = number[][];

export type Point3 = { x: number; y: number; z: number };

/**
 * Project one 384-d vector into the snapshot's three components.
 *
 * `vector` is a raw embedding (unit-norm, as `embed()` and the stored halfvecs
 * both are); centring by `mean` happens here so callers never have to remember.
 */
export function project(vector: number[], basis: Basis, mean: number[]): Point3 {
  const dim = mean.length;
  if (vector.length !== dim) {
    throw new Error(`projection: expected ${dim}-d vector, got ${vector.length}`);
  }

  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const axis = basis[c];
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += (vector[i] - mean[i]) * axis[i];
    out[c] = dot;
  }
  return { x: out[0], y: out[1], z: out[2] };
}

/** Parse pgvector/halfvec `::text` output — `"[a,b,c]"` — into numbers. */
export function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(",").map(Number);
}
