/**
 * Build the frequency table used to stratify eval targets.
 *
 * Source: hermitdave/FrequencyWords 2018 English (OpenSubtitles). Chosen for
 * register — it is conversational text, which is what reverse-dictionary
 * queries are, rather than the literary/technical skew of a book corpus.
 *
 * Output is a checked-in static artifact, `eval/data/zipf-en.tsv`, restricted
 * to lemmas that exist in `VocabEmbedding`. It is NOT an npm dependency and is
 * not read by the app.
 *
 * Zipf scale: log10(occurrences per billion words). ~7 = "the", ~5 = an
 * everyday word, ~3 = fairly rare, ~1 = very rare.
 *
 * Multi-word lemmas take the MINIMUM Zipf of their component tokens: the
 * rarest word gates the phrase ("solar eclipse" is as rare as "eclipse").
 *
 *   npx tsx scripts/build-freq-table.ts <path-to-en_full.txt>
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { bandOf, FREQ_BANDS, type FreqBand } from "./lib/freq";

loadEnv();

const prisma = new PrismaClient();
const OUT_PATH = path.resolve(process.cwd(), "eval/data/zipf-en.tsv");

async function readFrequencies(file: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let total = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of rl) {
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const word = line.slice(0, space);
    const n = Number(line.slice(space + 1));
    if (!Number.isFinite(n)) continue;
    counts.set(word, n);
    total += n;
  }

  const zipf = new Map<string, number>();
  for (const [word, n] of counts) {
    zipf.set(word, Math.log10((n / total) * 1e9));
  }
  console.log(`  read ${counts.size.toLocaleString()} words, ${total.toLocaleString()} tokens`);
  return zipf;
}

function zipfFor(lemma: string, zipf: Map<string, number>): number | null {
  const tokens = lemma.toLowerCase().split(/[ _-]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let min = Infinity;
  for (const token of tokens) {
    const z = zipf.get(token);
    if (z === undefined) return null; // any unknown component makes the phrase rare
    min = Math.min(min, z);
  }
  return min;
}

async function main(): Promise<void> {
  const source = process.argv[2];
  if (!source || !fs.existsSync(source)) {
    console.error("usage: npx tsx scripts/build-freq-table.ts <path-to-en_full.txt>");
    process.exitCode = 1;
    return;
  }

  console.log("Reading frequency source...");
  const zipf = await readFrequencies(source);

  console.log("Reading vocabulary...");
  const lemmas = await prisma.$queryRawUnsafe<{ word: string }[]>(
    `SELECT word FROM "VocabEmbedding" WHERE word ~ '^[a-z]' ORDER BY word`
  );
  console.log(`  ${lemmas.length.toLocaleString()} lowercase lemmas`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const out: string[] = [
    "# word\tzipf",
    "# Zipf = log10(occurrences per billion). Source: hermitdave/FrequencyWords",
    "# 2018 English (OpenSubtitles). Multi-word lemmas use min(component zipf).",
    "# Lemmas with no frequency data are omitted; treat absence as band 'rare'.",
  ];

  const bandCounts = new Map<FreqBand, number>();
  let matched = 0;

  for (const { word } of lemmas) {
    const z = zipfFor(word, zipf);
    if (z === null) continue;
    matched++;
    out.push(`${word}\t${z.toFixed(3)}`);
    const band = bandOf(z);
    bandCounts.set(band, (bandCounts.get(band) ?? 0) + 1);
  }

  fs.writeFileSync(OUT_PATH, out.join("\n") + "\n", "utf8");

  const unmatched = lemmas.length - matched;
  console.log(`\nWrote ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log(`  ${matched.toLocaleString()} lemmas with frequency data`);
  console.log(`  ${unmatched.toLocaleString()} with none (band 'rare' by absence)`);
  console.log(`\nBand distribution over the ${lemmas.length.toLocaleString()} lowercase lemmas:`);
  for (const band of FREQ_BANDS) {
    const n = (bandCounts.get(band) ?? 0) + (band === "rare" ? unmatched : 0);
    const pctv = ((n / lemmas.length) * 100).toFixed(1);
    console.log(`  ${band.padEnd(12)} ${String(n).padStart(7)}  ${pctv.padStart(5)}%`);
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
