/**
 * Which dictionary words are missing from the index, broken down by word type.
 *
 * Prompted by finding `loiterer` indexed while `loiter` was not. The dictionary
 * has `loiter`, so the original build dropped it — meaning the index is not the
 * dictionary's word list in the way everyone assumed. If verbs are missing
 * systematically, that caps how well a whole class of question can ever do, and
 * no amount of rebuilding the index fixes it.
 *
 * Read-only.
 *
 *   npx tsx scripts/audit-pos-coverage.ts
 */
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "./lib/env";
import { POS_LIST, readIndex, readSenses, type Pos } from "./lib/wordnet";

loadEnv();

const prisma = new PrismaClient();

/** Common word endings, for the base-verb versus derived-noun spot check. */
const DERIVATIONS: { suffix: string; strip: number; add: string }[] = [
  { suffix: "er", strip: 2, add: "" },
  { suffix: "er", strip: 3, add: "e" }, // loiterer -> loiter handled via "er" on stem
  { suffix: "ing", strip: 3, add: "" },
  { suffix: "ion", strip: 3, add: "e" },
  { suffix: "tion", strip: 4, add: "te" },
  { suffix: "ment", strip: 4, add: "" },
  { suffix: "ance", strip: 4, add: "" },
  { suffix: "al", strip: 2, add: "" },
];

function heading(title: string): void {
  console.log(`\n${"=".repeat(74)}\n${title}\n${"=".repeat(74)}`);
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  console.log("Reading VocabEmbedding...");
  const rows = await prisma.$queryRawUnsafe<{ word: string }[]>(
    `SELECT word FROM "VocabEmbedding"`
  );
  const vocabExact = new Set(rows.map((r) => r.word));
  const vocabLower = new Set(rows.map((r) => r.word.toLowerCase()));
  console.log(`  ${vocabExact.size.toLocaleString()} rows\n`);

  console.log("Reading WordNet 3.0 index files...");
  const byPos = new Map<Pos, string[]>();
  for (const pos of POS_LIST) {
    const lemmas = readIndex(pos);
    byPos.set(pos, lemmas);
    console.log(`  index.${pos.padEnd(5)} ${lemmas.length.toLocaleString()} lemmas`);
  }

    // A word can be both a noun and a verb, so the combined list is the most the
    // index could possibly contain.
  const union = new Set<string>();
  for (const lemmas of byPos.values()) for (const l of lemmas) union.add(l);

  heading("Presence rate by part of speech");
  console.log(
    `  ${"pos".padEnd(6)} ${"lemmas".padStart(9)} ${"present".padStart(9)} ` +
      `${"missing".padStart(9)} ${"rate".padStart(7)}`
  );
  console.log("  " + "-".repeat(46));

  const missingByPos = new Map<Pos, string[]>();
  for (const pos of POS_LIST) {
    const lemmas = byPos.get(pos)!;
    const missing = lemmas.filter(
      (l) => !vocabExact.has(l) && !vocabLower.has(l.toLowerCase())
    );
    missingByPos.set(pos, missing);
    const present = lemmas.length - missing.length;
    console.log(
      `  ${pos.padEnd(6)} ${lemmas.length.toLocaleString().padStart(9)} ` +
        `${present.toLocaleString().padStart(9)} ${missing.length.toLocaleString().padStart(9)} ` +
        `${pct(present, lemmas.length).padStart(7)}`
    );
  }

  const unionMissing = [...union].filter(
    (l) => !vocabExact.has(l) && !vocabLower.has(l.toLowerCase())
  );
  console.log("  " + "-".repeat(46));
  console.log(
    `  ${"ALL".padEnd(6)} ${union.size.toLocaleString().padStart(9)} ` +
      `${(union.size - unionMissing.length).toLocaleString().padStart(9)} ` +
      `${unionMissing.length.toLocaleString().padStart(9)} ` +
      `${pct(union.size - unionMissing.length, union.size).padStart(7)}`
  );

    // Indexed words the dictionary does not have at all. Compared ignoring case,
    // since the dictionary is all lowercase and the index is not.
  const unionLower = new Set([...union].map((l) => l.toLowerCase()));
  const extra = [...vocabLower].filter((w) => !unionLower.has(w));
  console.log(`\n  VocabEmbedding rows not in any WordNet index: ${extra.length.toLocaleString()}`);
  if (extra.length) console.log(`    e.g. ${extra.slice(0, 12).join(", ")}`);

    // Numbers dominate the raw missing counts and are useless for a reverse
    // dictionary anyway. Strip them to see what is really being lost.
  const isNumeric = (l: string) => /\d/.test(l);
  heading("Missing lemmas, excluding anything containing a digit");
  console.log(
    `  ${"pos".padEnd(6)} ${"lemmas".padStart(9)} ${"missing".padStart(9)} ${"rate".padStart(7)}`
  );
  console.log("  " + "-".repeat(36));
  for (const pos of POS_LIST) {
    const lemmas = byPos.get(pos)!.filter((l) => !isNumeric(l));
    const missing = missingByPos.get(pos)!.filter((l) => !isNumeric(l));
    console.log(
      `  ${pos.padEnd(6)} ${lemmas.length.toLocaleString().padStart(9)} ` +
        `${missing.length.toLocaleString().padStart(9)} ` +
        `${pct(lemmas.length - missing.length, lemmas.length).padStart(7)}`
    );
  }

  heading("Samples of what is missing, by part of speech");
  for (const pos of POS_LIST) {
    const missing = missingByPos.get(pos)!;
    const singleWord = missing.filter((l) => !l.includes(" "));
    console.log(`\n  ${pos} — ${missing.length.toLocaleString()} missing, ${singleWord.length.toLocaleString()} of them single-word`);
    console.log(`    ${singleWord.slice(0, 30).join(", ")}`);
  }

  heading("Are derived nouns present where their base verbs are absent?");
  const missingVerbs = new Set(missingByPos.get("verb")!.filter((l) => !l.includes(" ")));
  const hits: { derived: string; base: string }[] = [];

  for (const word of vocabLower) {
    if (word.includes(" ")) continue;
    for (const d of DERIVATIONS) {
      if (!word.endsWith(d.suffix) || word.length <= d.strip + 2) continue;
      const base = word.slice(0, word.length - d.strip) + d.add;
      if (missingVerbs.has(base)) {
        hits.push({ derived: word, base });
        break;
      }
    }
  }

  console.log(
    `\n  ${hits.length.toLocaleString()} cases where a derived form is indexed but its base verb is not.`
  );
  console.log(`  Sample:`);
  for (const h of hits.slice(0, 40)) {
    console.log(`    ${h.derived.padEnd(22)} present, but "${h.base}" is missing`);
  }

  heading("Is the CONCEPT still reachable when the word is missing?");
    // What actually matters is not whether a word is indexed, but whether any
    // word for that idea is. If `capsize` is missing but `turn turtle` is there,
    // the idea is still findable — just not by the word the user wanted.
  for (const pos of POS_LIST) {
    const senses = readSenses(pos);
    const missing = new Set(missingByPos.get(pos)!.filter((l) => !isNumeric(l)));
    if (missing.size === 0) continue;

    const orphaned = new Set(missing); // missing AND no synset-mate present
    for (const sense of senses) {
      const anyPresent = sense.words.some(
        (w) => vocabExact.has(w) || vocabLower.has(w.toLowerCase())
      );
      if (!anyPresent) continue;
      for (const w of sense.words) orphaned.delete(w);
    }

    const covered = missing.size - orphaned.size;
    console.log(
      `\n  ${pos}: ${missing.size.toLocaleString()} missing lemmas — ` +
        `${covered.toLocaleString()} have a synset-mate that IS indexed ` +
        `(${pct(covered, missing.size)}), ${orphaned.size.toLocaleString()} are fully orphaned.`
    );
    const sample = [...orphaned].filter((l) => !l.includes(" ")).slice(0, 20);
    if (sample.length) console.log(`    orphaned sample: ${sample.join(", ")}`);
  }

  heading("Verdict");
  const verbRate =
    (byPos.get("verb")!.length - missingByPos.get("verb")!.length) /
    byPos.get("verb")!.length;
  const nounRate =
    (byPos.get("noun")!.length - missingByPos.get("noun")!.length) /
    byPos.get("noun")!.length;
  console.log(`  verb presence ${(verbRate * 100).toFixed(1)}%, noun presence ${(nounRate * 100).toFixed(1)}%`);
  if (nounRate - verbRate > 0.1) {
    console.log(`  Verbs are materially underrepresented relative to nouns. Query classes`);
    console.log(`  that want a verb as the answer are capped no matter what is indexed.`);
  } else {
    console.log(`  No large POS skew; the gaps are distributed, not systematic by POS.`);
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
