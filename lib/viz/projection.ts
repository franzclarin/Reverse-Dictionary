// Flattening 384 numbers down to 3, so a meaning can be drawn as a dot. Both
// the background cloud and the live answer are placed by this same rule, so
// every dot lands where it truly belongs.
//
// The picture loses most of the detail, and the page says so on screen.
// Rankings always come from the full 384 numbers, never from these dots.

export const VIZ_DIM = 384;

/** The three directions we flatten onto. */
export type Basis = number[][];

export type Point3 = { x: number; y: number; z: number };

/** Place one meaning as a dot. Centring is handled here, so callers can't forget. */
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

/** Read the database's "[a,b,c]" text form back into numbers. */
export function parseVectorLiteral(literal: string): number[] {
  return literal.slice(1, -1).split(",").map(Number);
}
