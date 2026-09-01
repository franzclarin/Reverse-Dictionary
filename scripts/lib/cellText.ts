// The one place that decides what text goes into an experiment, plus a
// fingerprint of it. Kept apart from both the builder and the checker, so they
// cannot each hold their own drifting copy of the answer.
//
// The fingerprint exists because a half-finished rebuild once left files that
// were argued to be correct rather than shown to be. Now a file states exactly
// what it was built from, and the checker recomputes it and compares.
import crypto from "node:crypto";

export type GlossLike = { word: string; gloss: string; examples: string[] };

/** Text indexed for one gloss row, per cell variant. */
export function glossTextFor(variant: string, g: GlossLike): string {
  if (variant === "gloss_examples" && g.examples.length) {
    // Example sentences sound more natural than a definition, but they describe
    // one particular case rather than the meaning.
    return `${g.gloss}; ${g.examples.join("; ")}`;
  }
  if (variant === "lemma_gloss") {
    // Risks bringing back the word-repeating problem this index exists to fix,
    // and makes every row unique, which breaks the ties between synonyms.
    return `${g.word}: ${g.gloss}`;
  }
  return g.gloss;
}

/** The texts an experiment was built from, in order. */
// Order is part of the fingerprint: row 5 of the numbers must be text 5.
export function cellInputTexts(
  representation: "lemma" | "gloss",
  variant: string,
  pool: { words: string[]; glosses: GlossLike[] }
): string[] {
  return representation === "lemma"
    ? pool.words.slice()
    : pool.glosses.map((g) => glossTextFor(variant, g));
}

/** Fingerprint of the whole text list. */
// Joined with an invisible separator, so a text containing a line break cannot
// disguise itself as two entries.
export function inputsSha256(texts: string[]): string {
  const hash = crypto.createHash("sha256");
  const NUL = Buffer.from([0]); // explicit, so no literal NUL byte lives in this source file
  for (const t of texts) {
    hash.update(t, "utf8");
    hash.update(NUL);
  }
  return hash.digest("hex");
}

/** Fingerprint of the numbers file itself. */
export function bytesSha256(buf: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
