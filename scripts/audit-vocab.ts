/**
 * Phase A — vocabulary audit.
 *
 * `VocabEmbedding` is the WordNet 3.0 lemma set. WordNet is a lexical database,
 * not an answer key: it carries proper nouns, taxonomic binomials, and
 * multi-word collocations that can never be the answer to "what's the word
 * for...". Every one of those still occupies space in the index and crowds the
 * neighbourhood around lemmas that *can* be answers.
 *
 * This quantifies that, and converts the index statistic into a user-visible
 * one by measuring how much junk comes back in the top 10 for real queries.
 *
 * Read-only. Proposes a filter; applies nothing.
 *
 *   npx tsx scripts/audit-vocab.ts
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { embed } from "@/lib/embedder";
import { search, junkPredicate } from "./lib/retrieval";
import { loadEnv } from "./lib/env";
import { PROBE_QUERIES, contentTokens, echoesQuery } from "./lib/probes";

loadEnv();

const prisma = new PrismaClient();
const SAMPLE_DIR = path.resolve(process.cwd(), "eval/audit");
const SAMPLES_PER_CATEGORY = 200;
const INLINE_SAMPLE = 24;


/** Category predicates, evaluated in SQL so the counts are exact. */
const CATEGORIES: { key: string; label: string; sql: string }[] = [
  { key: "multiword", label: "multi-word (space or underscore)", sql: `word ~ '[ _]'` },
  { key: "capitalised", label: "starts with a capital letter", sql: `word ~ '^[A-Z]'` },
  { key: "digit", label: "contains a digit", sql: `word ~ '[0-9]'` },
  { key: "hyphen", label: "contains a hyphen", sql: `word ~ '-'` },
  { key: "apostrophe", label: "contains an apostrophe", sql: `word ~ ''''` },
  {
    key: "other_punct",
    label: "contains other punctuation",
    sql: `word ~ '[^A-Za-z0-9 _''-]'`,
  },
  {
    key: "case_collision",
    label: "collides with another lemma on lower()",
    sql: `lower(word) IN (SELECT lower(word) FROM "VocabEmbedding" GROUP BY 1 HAVING count(*) > 1)`,
  },
  {
    key: "clean_single",
    label: "single word, all lowercase letters",
    sql: `word ~ '^[a-z]+$'`,
  },
];

function heading(title: string): void {
  console.log(`\n${"=".repeat(74)}\n${title}\n${"=".repeat(74)}`);
}

async function count(where: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "VocabEmbedding" WHERE ${where}`
  );
  return Number(rows[0].n);
}

async function sampleWords(where: string, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ word: string }[]>(
    // md5 ordering gives a spread-out but perfectly reproducible sample.
    `SELECT word FROM "VocabEmbedding" WHERE ${where} ORDER BY md5(word) LIMIT ${limit}`
  );
  return rows.map((r) => r.word);
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const total = await count("true");

  // ---------------------------------------------------------------- breakdown
  heading(`Category breakdown (${total.toLocaleString()} lemmas)`);
  const counts = new Map<string, number>();
  for (const cat of CATEGORIES) {
    const n = await count(cat.sql);
    counts.set(cat.key, n);
    console.log(`  ${cat.label.padEnd(44)} ${String(n).padStart(7)}  ${pct(n, total).padStart(6)}`);
  }

  // ------------------------------------------------------------- overlaps
  heading("Overlaps — where the categories double-count");
  const overlapPairs: [string, string][] = [
    [`word ~ '[ _]'`, `word ~ '^[A-Z]'`],
    [`word ~ '[ _]'`, `word ~ '[0-9]'`],
    [`word ~ '^[A-Z]'`, `word ~ '[0-9]'`],
    [`word ~ '[ _]'`, `word ~ '-'`],
    [`word ~ '^[A-Z]'`, `word ~ '[^A-Za-z0-9 _''-]'`],
  ];
  const labelOf = (sql: string) =>
    CATEGORIES.find((c) => c.sql === sql)?.label ?? sql;
  for (const [a, b] of overlapPairs) {
    const n = await count(`(${a}) AND (${b})`);
    console.log(`  ${labelOf(a)}\n    AND ${labelOf(b)}: ${n} (${pct(n, total)})`);
  }

  // -------------------------------------------------------------- the union
  heading("Unions — candidate filters, from conservative to aggressive");
  const unions: { name: string; sql: string; note: string }[] = [
    {
      name: "A. proper nouns only",
      sql: `word ~ '^[A-Z]'`,
      note: "safest; removes Peary, Damascene, genus names",
    },
    {
      name: "B. proper nouns + digits + odd punctuation",
      sql: `word ~ '^[A-Z]' OR word ~ '[0-9]' OR word ~ '[^A-Za-z0-9 _''-]'`,
      note: "RECOMMENDED — keeps every legitimate multi-word lemma",
    },
    {
      name: "C. B + all multi-word",
      sql: `word ~ '^[A-Z]' OR word ~ '[0-9]' OR word ~ '[^A-Za-z0-9 _''-]' OR word ~ '[ _]'`,
      note: "aggressive; also deletes 'deja vu', 'red herring'",
    },
    {
      name: "D. keep only ^[a-z]+$",
      sql: `word !~ '^[a-z]+$'`,
      note: "most aggressive; also deletes hyphenated and possessive lemmas",
    },
  ];
  for (const u of unions) {
    const removed = await count(u.sql);
    const kept = total - removed;
    console.log(
      `  ${u.name.padEnd(38)} removes ${String(removed).padStart(7)} (${pct(removed, total).padStart(6)})` +
        `  -> pool ${kept.toLocaleString().padStart(9)}`
    );
    console.log(`     ${u.note}`);
  }

  // ------------------------------------------------- what the filter costs
  heading("Cost of the capitalisation rule");
  const [cost] = await prisma.$queryRawUnsafe<
    { with_twin: bigint; single_no_twin: bigint; multi_no_twin: bigint }[]
  >(
    `SELECT count(*) FILTER (WHERE twin)::bigint                          AS with_twin,
            count(*) FILTER (WHERE NOT twin AND word !~ '[ _]')::bigint   AS single_no_twin,
            count(*) FILTER (WHERE NOT twin AND word ~ '[ _]')::bigint    AS multi_no_twin
       FROM (
         SELECT v.word,
                EXISTS (SELECT 1 FROM "VocabEmbedding" u
                         WHERE u.word = lower(v.word) AND u.word <> v.word) AS twin
           FROM "VocabEmbedding" v
          WHERE v.word ~ '^[A-Z]'
       ) t`
  );
  console.log(
    `  capitalised WITH a lowercase twin already in the pool: ${Number(cost.with_twin)}`
  );
  console.log(`    -> removing these costs nothing; it de-duplicates a wasted slot.`);
  console.log(
    `  capitalised, single word, NO twin:                     ${Number(cost.single_no_twin)}`
  );
  console.log(`    -> the real cost. Mostly place/person names, but also Monday, Braille, Sikh.`);
  console.log(
    `  capitalised, multi-word, NO twin:                      ${Number(cost.multi_no_twin)}`
  );
  console.log(`    -> taxonomy and proper names ("Treaty of Versailles"), plus a few real`);
  console.log(`       answers ("Scotch egg", "Japanese persimmon").`);

  // ---------------------------------------------------------------- samples
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  const samplePath = path.join(SAMPLE_DIR, "vocab-samples.txt");
  const out: string[] = [
    `Vocabulary audit samples — ${SAMPLES_PER_CATEGORY} per category`,
    `Source: VocabEmbedding (${total} rows). Deterministic sample: ORDER BY md5(word).`,
    "",
  ];

  heading(`Samples (${INLINE_SAMPLE} shown inline, ${SAMPLES_PER_CATEGORY} written to file)`);
  for (const cat of CATEGORIES) {
    const words = await sampleWords(cat.sql, SAMPLES_PER_CATEGORY);
    out.push(`${"=".repeat(70)}`, `${cat.label}  (${counts.get(cat.key)} rows)`, `${"=".repeat(70)}`);
    out.push(...words.map((w) => `  ${w}`), "");

    console.log(`\n  ${cat.label} (${counts.get(cat.key)}):`);
    console.log(`    ${words.slice(0, INLINE_SAMPLE).join(" | ")}`);
  }
  fs.writeFileSync(samplePath, out.join("\n"), "utf8");
  console.log(`\n  Full samples written to ${path.relative(process.cwd(), samplePath)}`);

  // ------------------------------------------------- top-10 pollution rate
  if (process.argv.includes("--no-queries")) {
    console.log("\n  (--no-queries: skipping the retrieval probe)\n");
    return;
  }
  heading("Top-10 pollution on 25 hand-written user-voice queries");
  console.log("  Warming the embedder...");
  await embed("warm up");

  const junkSql = junkPredicate();
  let totalResults = 0;
  let totalJunk = 0;
  let totalEcho = 0;
  const reach: { answer: string; inVocab: boolean; rank: number | null }[] = [];

  for (const { query, answer } of PROBE_QUERIES) {
    const vector = await embed(query);
    const rows = await search(prisma, vector, { k: 10 });
    const words = rows.map((r) => r.word);

    const flagged = await prisma.$queryRawUnsafe<{ word: string }[]>(
      `SELECT word FROM "VocabEmbedding" WHERE word = ANY($1::text[]) AND (${junkSql})`,
      words
    );
    const junkSet = new Set(flagged.map((r) => r.word));

    const queryTokens = contentTokens(query);
    const echoSet = new Set(words.filter((w) => echoesQuery(w, queryTokens)));

    totalResults += words.length;
    totalJunk += junkSet.size;
    totalEcho += echoSet.size;

    // Is the word I had in mind even reachable?
    const [{ n: present }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "VocabEmbedding" WHERE lower(word) = lower($1)`,
      answer
    );
    const idx = words.findIndex((w) => w.toLowerCase() === answer.toLowerCase());
    reach.push({ answer, inVocab: Number(present) > 0, rank: idx === -1 ? null : idx + 1 });

    const rendered = words.map((w) => {
      if (junkSet.has(w)) return `*${w}*`;
      if (echoSet.has(w)) return `~${w}~`;
      return w;
    });
    console.log(`\n  [junk ${junkSet.size}/10, echo ${echoSet.size}/10] ${query}`);
    console.log(`    ${rendered.join(", ")}`);
  }

  console.log(
    `\n  UNANSWERABLE (proper noun / digit / punctuation): ${totalJunk}/${totalResults} ` +
      `(${pct(totalJunk, totalResults)})   [marked *word*]`
  );
  console.log(
    `  LEXICAL ECHO (shares a stem with a query content word): ${totalEcho}/${totalResults} ` +
      `(${pct(totalEcho, totalResults)})   [marked ~word~]`
  );

  heading("Reachability of the answer I had in mind");
  const missingFromVocab = reach.filter((r) => !r.inVocab);
  const inVocabRetrieved = reach.filter((r) => r.inVocab && r.rank !== null);
  const inVocabMissed = reach.filter((r) => r.inVocab && r.rank === null);
  for (const r of reach) {
    const status = !r.inVocab
      ? "NOT IN VOCAB   (coverage gap)"
      : r.rank === null
        ? "in vocab, NOT in top-10   (ranking failure)"
        : `in vocab, rank ${r.rank}`;
    console.log(`  ${r.answer.padEnd(18)} ${status}`);
  }
  console.log(
    `\n  ${missingFromVocab.length}/25 unreachable, ` +
      `${inVocabMissed.length}/25 reachable but not ranked, ` +
      `${inVocabRetrieved.length}/25 retrieved in top-10`
  );

  // -------------------------------------------------------- proposed filter
  heading("Proposed filter — NOT APPLIED");
  console.log(`
  A view, so it is reversible and A/B-able. No DELETE, no column, no rewrite
  of the base table, and the IVFFlat index on "VocabEmbedding" still serves it.

    CREATE VIEW answerable_vocab AS
    SELECT id, word, embedding
      FROM "VocabEmbedding"
     WHERE NOT (
           ${junkSql}
     );

  To A/B without creating anything, the same predicate goes inline — which is
  exactly what \`scripts/eval.ts --filter-junk\` does:

    SELECT word, 1 - (embedding <=> $1::vector) AS similarity
      FROM "VocabEmbedding"
     WHERE NOT (${junkSql.replace(/\n\s+/g, " ")})
     ORDER BY embedding <=> $1::vector
     LIMIT $2;
`);

  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
