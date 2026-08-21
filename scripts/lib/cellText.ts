/**
 * The single definition of what text goes into a cell, and its fingerprint.
 *
 * This lives apart from both the builder and the verifier on purpose. If the
 * builder and the checker each had their own copy of "what text does variant X
 * index?", they could drift, and a drifted checker passes a wrong cell —
 * exactly the class of bug the check exists to catch.
 *
 * WHY THE FINGERPRINT. Nine concurrent processes once wrote overlapping cell
 * outputs during an interrupted rebuild. The files were argued to be correct
 * from timestamps and throughput rates, which is inference, not proof, and every
 * downstream number depends on these files being what they claim. Hashing the
 * ordered input list turns that argument into a check: a cell states the exact
 * text sequence it was built from, and the verifier recomputes that sequence
 * from the manifest and compares.
 */
import crypto from "node:crypto";

export type GlossLike = { word: string; gloss: string; examples: string[] };

/** Text indexed for one gloss row, per cell variant. */
export function glossTextFor(variant: string, g: GlossLike): string {
  if (variant === "gloss_examples" && g.examples.length) {
    // WordNet's examples are usage sentences ("he loitered on the corner") —
    // closer to natural language than the definition, but about a specific
    // referent rather than the meaning.
    return `${g.gloss}; ${g.examples.join("; ")}`;
  }
  if (variant === "lemma_gloss") {
    // Keeps lexical signal at the risk of reintroducing the echo the gloss
    // index exists to remove. Also makes every row's text unique, which
    // incidentally breaks the synonym ties the other gloss variants have.
    return `${g.word}: ${g.gloss}`;
  }
  return g.gloss;
}

/**
 * The ordered input texts for a cell, reconstructed from the pool.
 *
 * Order matters and is part of the fingerprint: row i of the vector file must
 * correspond to text i.
 */
export function cellInputTexts(
  representation: "lemma" | "gloss",
  variant: string,
  pool: { words: string[]; glosses: GlossLike[] }
): string[] {
  return representation === "lemma"
    ? pool.words.slice()
    : pool.glosses.map((g) => glossTextFor(variant, g));
}

/**
 * SHA256 over the ordered text list.
 *
 * NUL-separated rather than newline-separated so that a text containing a
 * newline could not forge a different partition of the same byte stream.
 */
export function inputsSha256(texts: string[]): string {
  const hash = crypto.createHash("sha256");
  const NUL = Buffer.from([0]); // explicit, so no literal NUL byte lives in this source file
  for (const t of texts) {
    hash.update(t, "utf8");
    hash.update(NUL);
  }
  return hash.digest("hex");
}

/** SHA256 of a vector file's raw bytes — pins the artifact itself. */
export function bytesSha256(buf: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
