/**
 * Build a full-size experiment index straight from the dictionary, for any model.
 *
 * The other builder works from a smaller sampled pool whose scores deliberately
 * aren't comparable to production, and it can only hold one width of model. This
 * one covers every meaning the live site searches and takes any model, going
 * from dictionary to file with no database in between.
 *
 * The result is searched exhaustively, so it is exact — which makes it the right
 * tool for a question about how words are represented, and the wrong one for a
 * question about speed.
 *
 * The one real hazard: if the questions are measured by a different model than
 * the entries were, the comparison is nonsense that looks like a finding. The
 * scorer guards against this by reading the model out of the file, so this
 * script's one non-negotiable duty is to record the model it actually used.
 *
 * Every model here is treated the same way — averaged, then rescaled. Models
 * that need different handling would be silently mis-measured and must not be
 * built here without teaching the scorer the same rule.
 *
 *   npx tsx scripts/build-encoder-cell.ts --model Xenova/gte-small --out full_gloss_gte
 *   npx tsx scripts/build-encoder-cell.ts --variant gloss_examples --out full_gloss_ft_ex
 *   npx tsx scripts/build-encoder-cell.ts --limit 500        # benchmark; writes nothing
 */
import { embedWith, PRODUCTION_MODEL } from "./lib/embedModel";
import { bytesSha256, glossTextFor, inputsSha256 } from "./lib/cellText";
import { writeIndex, cellDir, type CellMeta } from "./lib/localIndex";
import { POS_LIST, readSenses } from "./lib/wordnet";

/** The exact label the scorer looks for to know this is a meaning-keyed index. */
// Which *text* was indexed cannot live in this field; it is recorded in the
// file's name, its note, and — bindingly — in the fingerprint of its inputs.
const HARNESS_SYNSET_VARIANT = "gloss_synset";

/** The live row count, as a drift check rather than a requirement. */
const EXPECTED_SYNSETS = 117_791;

type Synset = { key: string; words: string[]; gloss: string; examples: string[] };

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** One row per meaning, in the dictionary's own file order. */
// Every line of the source already is one meaning, so this reads rather than
// groups. Never sort the words within a meaning: the scorer reads that same
// order back at query time, so reordering here would silently change how ties
// are broken in production.
function readSynsets(): Synset[] {
  const out: Synset[] = [];
  for (const pos of POS_LIST) {
    for (const sense of readSenses(pos)) {
      out.push({
        key: `${sense.pos}:${sense.offset}`,
        words: sense.words,
        gloss: sense.gloss,
        examples: sense.examples,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const model = arg("--model") ?? PRODUCTION_MODEL;
  const variant = arg("--variant") ?? "gloss";
  const limit = Number(arg("--limit") ?? NaN);
  const benchmark = Number.isFinite(limit) && limit > 0;
  const out = arg("--out") ?? (benchmark ? "benchmark" : undefined);
  const dir = arg("--dir") ?? cellDir();

  if (!out) {
    console.error("--out <cell-name> is required (or use --limit for a benchmark run).");
    process.exitCode = 1;
    return;
  }

  let synsets = readSynsets();
  console.log(`\nWordNet      ${synsets.length.toLocaleString()} synsets across ${POS_LIST.join(", ")}`);
  if (synsets.length !== EXPECTED_SYNSETS) {
    console.log(
      `  NOTE: Phase E counted ${EXPECTED_SYNSETS.toLocaleString()}. A different wordnet-db ` +
        `version is a legitimate cause, but check before comparing this cell to an older one.`
    );
  }
  if (benchmark) synsets = synsets.slice(0, limit);

    // The one place that decides what text goes in. A second copy here is exactly
    // the drift that shared file was split out to prevent.
  const texts = synsets.map((s) =>
    glossTextFor(variant, { word: s.words[0], gloss: s.gloss, examples: s.examples })
  );

  console.log(`cell         ${out}${benchmark ? "  [BENCHMARK — nothing written]" : ""}`);
  console.log(`model        ${model}`);
  console.log(`text variant ${variant}`);
  console.log(`rows         ${texts.length.toLocaleString()}`);
  console.log(`out dir      ${dir}`);

  process.stdout.write(`\n  loading model... `);
  const warmStart = Date.now();
  const probe = await embedWith(model, "warm up");
  const dim = probe.length;
  console.log(`${Date.now() - warmStart}ms  (${dim} dimensions)`);

    // One flat block of memory: the same numbers held as ordinary nested arrays
    // would take several gigabytes instead of a few hundred megabytes.
  const vectors = new Float32Array(texts.length * dim);
  const started = Date.now();
  for (let i = 0; i < texts.length; i++) {
    const vector = await embedWith(model, texts[i]);
    if (vector.length !== dim) {
      throw new Error(`row ${i} came back ${vector.length}-dim, expected ${dim}`);
    }
    vectors.set(vector, i * dim);
    if ((i + 1) % 500 === 0 || i + 1 === texts.length) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = (i + 1) / elapsed;
      process.stdout.write(
        `\r  embedded ${(i + 1).toLocaleString()}/${texts.length.toLocaleString()}  ` +
          `${rate.toFixed(0)}/s  eta ${((texts.length - i - 1) / rate / 60).toFixed(1)}m    `
      );
    }
  }
  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `\n\n  ${texts.length.toLocaleString()} rows in ${(elapsed / 60).toFixed(1)}m ` +
      `(${(texts.length / elapsed).toFixed(0)}/s)`
  );

  if (benchmark) {
    const full = readSynsets().length;
    console.log(
      `  projected for all ${full.toLocaleString()} rows: ` +
        `${(full / (texts.length / elapsed) / 60).toFixed(1)} minutes, ` +
        `${((full * dim * 4) / 1e6).toFixed(0)} MB on disk\n`
    );
    return;
  }

  const words = synsets.map((s) => s.words[0]);
  const synsetMembers: Record<string, string[]> = {};
  for (const s of synsets) synsetMembers[s.key] = s.words;

  const meta: Omit<CellMeta, "dim" | "rows" | "distinctWords" | "builtAt"> = {
    cell: out,
    model,
    variant: HARNESS_SYNSET_VARIANT,
    representation: "gloss",
        // Full dictionary, not the smaller sample. This field is what stops these
        // being compared against the small ones by accident.
    scale: "full",
    poolWords: new Set(synsets.flatMap((s) => s.words)).size,
    inputsSha256: inputsSha256(texts),
    vectorsSha256: bytesSha256(
      Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
    ),
    note:
      `RD-16 encoder sweep. Full WordNet 3.0: one row per synset, text variant ` +
      `"${variant}", encoded by ${model} with mean pooling and L2 normalisation. ` +
      `Built from wordnet-db directly — no database, no pool manifest — so it covers the ` +
      `same synsets the production GlossEmbedding table does and its absolute recall is ` +
      `comparable to a production run (exact scan here vs probes=40 there). NOT comparable ` +
      `to a sampled Phase E cell.`,
    words,
    senseKeys: synsets.map((s) => s.key),
    synsetMembers,
  };

  const written = writeIndex(meta, vectors, dir, dim);
  console.log(
    `  wrote ${out}.vec (${(written.bytes / 1e6).toFixed(0)} MB), ` +
      `${synsets.length.toLocaleString()} synsets covering ` +
      `${meta.poolWords!.toLocaleString()} words\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
