/**
 * What is actually stored in the index?
 *
 * The scripts that built it show how the numbers were moved around, not what
 * they represent. The only way to find out is to measure candidates again and
 * compare.
 *
 * If measuring a bare word matches what is stored for it almost exactly, the
 * index holds bare words — meaning every search compares a twelve-word
 * description against a single word.
 *
 * Read-only.  npx tsx scripts/probe-representation.ts
 */
import { PrismaClient } from "@prisma/client";
import { embed } from "@/lib/embedder";
import { loadEnv } from "./lib/env";

loadEnv();

const prisma = new PrismaClient();

/** Spans common and rare words, short and long. */
const PROBE_WORDS = [
  "rain",
  "dog",
  "run",
  "water",
  "happiness",
  "cemetery",
  "refraction",
  "palindrome",
  "procrastination",
  "denouement",
  "aglet",
  "creak",
  "windbag",
  "ascetic",
  "oblivion",
  "homophone",
  "philatelist",
  "betatron",
  "ziggurat",
  "hippopotamus",
  "solar eclipse",
  "can opener",
  "stiff upper lip",
  "deja vu",
];

/** Descriptions written from the idea, to test the other possibility. */
// If the index held definitions, these would score far higher than the bare
// word does. Rough paraphrases are enough — this separates "almost identical"
// from "barely related", not fine degrees of accuracy.
const PROBE_DESCRIPTIONS: Record<string, string> = {
  rain: "water falling in drops from clouds in the sky",
  cemetery: "a place where dead people are buried under headstones",
  refraction: "the bending of light as it passes from one material into another",
  palindrome: "a word or phrase that reads the same forwards and backwards",
  procrastination: "the habit of putting things off until the last minute",
  betatron: "a machine that accelerates electrons in a circular path using a magnetic field",
  "solar eclipse": "when the moon passes in front of the sun and blocks its light",
};

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function stats(values: number[]): { min: number; p50: number; mean: number; max: number } {
  const sorted = [...values].sort((x, y) => x - y);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length / 2)],
    mean: values.reduce((s, v) => s + v, 0) / values.length,
    max: sorted[sorted.length - 1],
  };
}

async function storedVector(word: string): Promise<number[] | null> {
  const rows = await prisma.$queryRawUnsafe<{ v: string }[]>(
    `SELECT embedding::text AS v FROM "VocabEmbedding" WHERE word = $1 LIMIT 1`,
    word
  );
  if (rows.length === 0) return null;
  return rows[0].v.slice(1, -1).split(",").map(Number);
}

async function main(): Promise<void> {
  console.log("Warming the embedder...");
  await embed("warm up");

    // The stored numbers should already be scaled to a standard length; check
    // that before trusting any comparison against them.
  const [{ v }] = await prisma.$queryRawUnsafe<{ v: string }[]>(
    `SELECT embedding::text AS v FROM "VocabEmbedding" WHERE word = 'rain'`
  );
  const norm = Math.sqrt(
    v.slice(1, -1).split(",").map(Number).reduce((s, x) => s + x * x, 0)
  );
  console.log(`Stored vector L2 norm (rain): ${norm.toFixed(6)}\n`);

  console.log(
    `${"word".padEnd(18)} ${"cos(embed(word), stored)".padStart(24)}  ${"cos(embed(desc), stored)".padStart(24)}`
  );
  console.log("-".repeat(70));

  const lemmaSims: number[] = [];
  const descSims: number[] = [];

  for (const word of PROBE_WORDS) {
    const stored = await storedVector(word);
    if (!stored) {
      console.log(`${word.padEnd(18)} ${"NOT IN VOCAB".padStart(24)}`);
      continue;
    }

    const lemmaSim = cosine(await embed(word), stored);
    lemmaSims.push(lemmaSim);

    let descCol = "";
    const description = PROBE_DESCRIPTIONS[word];
    if (description) {
      const descSim = cosine(await embed(description), stored);
      descSims.push(descSim);
      descCol = descSim.toFixed(4).padStart(24);
    }

        // Print the difference too: the original data was rounded, so an exact
        // re-measurement lands a hair below a perfect match rather than on it.
    const dev = (1 - lemmaSim).toExponential(1);
    console.log(
      `${word.padEnd(18)} ${lemmaSim.toFixed(6).padStart(14)} (1-cos=${dev.padStart(8)})  ${descCol}`
    );
  }

  const lemma = stats(lemmaSims);
  console.log("\n" + "=".repeat(70));
  console.log("cos(embed(word), stored[word]) over " + lemmaSims.length + " words");
  console.log(
    `  min ${lemma.min.toFixed(4)}   p50 ${lemma.p50.toFixed(4)}   ` +
      `mean ${lemma.mean.toFixed(4)}   max ${lemma.max.toFixed(4)}`
  );

  if (descSims.length) {
    const desc = stats(descSims);
    console.log(`\ncos(embed(description), stored[word]) over ${descSims.length} words`);
    console.log(
      `  min ${desc.min.toFixed(4)}   p50 ${desc.p50.toFixed(4)}   ` +
        `mean ${desc.mean.toFixed(4)}   max ${desc.max.toFixed(4)}`
    );
  }

  console.log("\nVERDICT:");
  if (lemma.mean > 0.98) {
    console.log("  Bare-lemma embeddings. The index stores encode(word), so every");
    console.log("  search matches a multi-word description against a 1-token document.");
  } else if (lemma.mean < 0.7 && descSims.length && stats(descSims).mean > lemma.mean) {
    console.log("  NOT bare lemmas — descriptions score higher. The index likely");
    console.log("  stores gloss or definition text; investigate the Colab build.");
  } else {
    console.log("  Ambiguous. Neither hypothesis is clean; investigate further.");
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
