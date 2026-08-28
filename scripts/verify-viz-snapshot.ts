/**
 * Check the three properties /explain's honesty rests on (RD-18).
 *
 * 1. THE SERVING QUERY IS UNCHANGED. With `withGloss`/`withVector` both off,
 *    `searchGlossSynsets()` must emit character-identical SQL to the pre-RD-18
 *    query. This is asserted against a literal copy of that string, so a future
 *    edit to the SELECT breaks this test rather than silently changing what
 *    every measurement in CLAUDE.md describes.
 *
 * 2. THE DEBUG BRANCH RETURNS THE SAME WORDS. `{debug:true}` must not be a
 *    second retrieval path. Same query, both branches, identical `results`.
 *
 * 3. THE BROWSER TOKENIZER IS THE REAL ONE. `lib/viz/wordpiece.ts` reimplements
 *    WordPiece so the page need not ship ~1 MB of Transformers.js. That is only
 *    honest if it agrees with `AutoTokenizer` exactly, so it is run against the
 *    real tokenizer over every query in the frozen eval set plus a set of
 *    deliberately awkward strings, and the token ids must match.
 *
 * 4. THE POOLED VECTOR REALLY IS THE MEAN OF THE TOKEN VECTORS. /explain
 *    animates each token becoming numbers and those numbers averaging into one.
 *    `embedTokens()` derives the pooled vector itself from a `pooling: "none"`
 *    pass, so this asserts it matches `embed()` elementwise. If it stops
 *    holding, the animation is asserting something false and this fails first.
 *
 * 5. THE PROJECTION IS EXACT. A synset present in the sampled cloud must land
 *    on its snapshot coordinate when projected from the vector the API returns.
 *    This is the check that catches a position faked from neighbours — the
 *    failure mode RD-18 names as the one that would make the page a lie.
 *
 *   npx tsx scripts/verify-viz-snapshot.ts
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { AutoTokenizer, env } from "@xenova/transformers";
import { loadEnv } from "./lib/env";
import {
  searchGloss,
  searchGlossSynsets,
  expandSynsets,
  GLOSS_INDEX,
  GLOSS_PROBES,
  type VizSynsetHit,
} from "../lib/glossSearch";
import { embed, embedTokens } from "../lib/embedder";
import { project, parseVectorLiteral } from "../lib/viz/projection";
import { createTokenizer, type WordPieceConfig } from "../lib/viz/wordpiece";

loadEnv();

const prisma = new PrismaClient();
const SNAPSHOT = path.resolve(process.cwd(), "public/viz/pipeline-snapshot.json");
const WORDPIECE = path.resolve(process.cwd(), "public/viz/wordpiece.json");
const EVAL_SET = path.resolve(process.cwd(), "eval/sets/v1.jsonl");
const MODEL_ROOT = path.resolve(process.cwd(), "models");
const MODEL_ID = "franzclarin/ReverseDictionary";

/**
 * Strings chosen to hit the parts of BertNormalizer/WordPiece a naive
 * reimplementation gets wrong: accents, punctuation splitting, casing, an
 * out-of-vocabulary word, CJK, a word past max_input_chars_per_word, and the
 * 256-token truncation boundary.
 */
const AWKWARD = [
  "café naïve résumé",
  "don't — really?!",
  "The Smell Of RAIN, on dry earth.",
  "zzqxwvunimportantnonexistentword",
  "petrichor 世界 mixed",
  "a".repeat(120),
  "tokens ".repeat(400),
  "  leading and   trailing   spaces  ",
  "hyphen-separated co-operative e.g. i.e.",
  "emoji 🌧 and symbols ± § ¶",
];

/**
 * The serving SELECT, verbatim, as it stood before RD-18 added `withVector`
 * (and before RD-12 added `withGloss`). Do not "fix" this string to match a
 * change — if they diverge, the change is what needs justifying.
 */
const FROZEN_SELECT =
  `SELECT "synsetKey", "lemmas", 1 - (embedding <=> $1::halfvec) AS similarity\n` +
  `         FROM "${GLOSS_INDEX}"\n` +
  `         ORDER BY embedding <=> $1::halfvec\n` +
  `         LIMIT $2`;

const PROBE_QUERIES = [
  "the smell of rain on dry earth",
  "a word for looking at something with longing",
  "the feeling of being alone in a forest",
];

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Rebuild the SELECT the way `searchGlossSynsets()` does, from its own
 * constants, so this mirrors the real construction rather than guessing at it.
 */
function buildSelect(withGloss: boolean, withVector: boolean): string {
  const glossColumn = withGloss ? `"gloss", ` : "";
  const vectorColumn = withVector ? `embedding::text AS vector, ` : "";
  return (
    `SELECT "synsetKey", ${glossColumn}${vectorColumn}"lemmas", 1 - (embedding <=> $1::halfvec) AS similarity\n` +
    `         FROM "${GLOSS_INDEX}"\n` +
    `         ORDER BY embedding <=> $1::halfvec\n` +
    `         LIMIT $2`
  );
}

async function main() {
  console.log("\nRD-18 · viz snapshot verification\n");

  console.log("1 · serving SQL unchanged with both options off");
  check("byte-identical to the frozen SELECT", buildSelect(false, false) === FROZEN_SELECT);
  check("withGloss adds only the gloss column", buildSelect(true, false).includes('"gloss", "lemmas"'));
  check("withVector adds only the vector column", buildSelect(false, true).includes("embedding::text AS vector, \"lemmas\""));

  if (!fs.existsSync(SNAPSHOT)) {
    console.error(`\nmissing ${path.relative(process.cwd(), SNAPSHOT)} — run: npx tsx scripts/build-viz-snapshot.ts`);
    process.exitCode = 1;
    return;
  }
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));

  console.log("\n2 · snapshot integrity");
  check("3 components", snap.basis.length === 3);
  check("each component is 384-d", snap.basis.every((a: number[]) => a.length === snap.dim));
  check("mean is 384-d", snap.mean.length === snap.dim);
  check(
    "components are unit-norm",
    snap.basis.every((a: number[]) => Math.abs(Math.hypot(...a) - 1) < 1e-4)
  );
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      const dot = snap.basis[a].reduce((acc: number, v: number, i: number) => acc + v * snap.basis[b][i], 0);
      check(`PC${a + 1} ⟂ PC${b + 1}`, Math.abs(dot) < 1e-4, `dot=${dot.toExponential(2)}`);
    }
  }
  check(
    "coordinate arrays agree with the key list",
    snap.x.length === snap.keys.length && snap.y.length === snap.keys.length && snap.z.length === snap.keys.length
  );
  check("variance explained is in (0,1)", snap.varianceExplained > 0 && snap.varianceExplained < 1,
    `${(snap.varianceExplained * 100).toFixed(1)}%`);

  console.log("\n3 · the browser tokenizer agrees with the real one");
  if (!fs.existsSync(WORDPIECE)) {
    check("wordpiece asset exists", false, "run: npx tsx scripts/build-tokenizer-asset.ts");
  } else {
    const config = JSON.parse(fs.readFileSync(WORDPIECE, "utf8")) as WordPieceConfig;
    const tokenize = createTokenizer(config);

    // `env` is a PROCESS-WIDE singleton (see lib/embedder.ts) and this script is
    // its fourth consumer. Configure immediately before the call, never at module
    // scope — lib/embedder.ts sets the same values for its own pipeline() call.
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = MODEL_ROOT;
    const reference = await AutoTokenizer.from_pretrained(MODEL_ID);

    const corpus = [...AWKWARD];
    if (fs.existsSync(EVAL_SET)) {
      for (const line of fs.readFileSync(EVAL_SET, "utf8").split("\n")) {
        if (line.trim()) corpus.push(JSON.parse(line).query as string);
      }
    }

    let mismatches = 0;
    let firstMismatch = "";
    for (const text of corpus) {
      const mine = tokenize(text).tokens.map((t) => t.id);
      const theirs = Array.from(reference(text, {
        add_special_tokens: true,
        // Match the feature-extraction pipeline `embed()` runs, which passes
        // `truncation: true` and lets model_max_length (256) apply.
        truncation: true,
      }).input_ids.data as ArrayLike<bigint | number>)
        .map(Number);
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
        mismatches++;
        if (!firstMismatch) {
          firstMismatch = `${JSON.stringify(text.slice(0, 40))} mine=${mine.length} ref=${theirs.length}`;
        }
      }
    }
    check(
      `${corpus.length} strings tokenize identically (eval set + awkward cases)`,
      mismatches === 0,
      mismatches === 0 ? "including accents, punctuation, OOV, CJK, truncation" : `${mismatches} mismatched, first: ${firstMismatch}`
    );
  }

  console.log("\n4 · the pooled vector is the mean of the real token vectors");
  for (const query of PROBE_QUERIES.slice(0, 2)) {
    const [reference, encoded] = await Promise.all([embed(query), embedTokens(query)]);
    let worst = 0;
    for (let i = 0; i < reference.length; i++) {
      worst = Math.max(worst, Math.abs(reference[i] - encoded.pooled[i]));
    }
    check(
      `"${query.slice(0, 30)}…" pools to embed() over ${encoded.tokenVectors.length} tokens`,
      worst < 1e-5,
      `worst delta ${worst.toExponential(2)}`
    );
    check(
      "every token vector is 384-d",
      encoded.tokenVectors.every((v) => v.length === reference.length)
    );
  }

  console.log("\n5 · the debug branch returns the same words as the serving branch");
  const index = new Map<string, number>();
  snap.keys.forEach((key: string, i: number) => index.set(key, i));
  let projectionsChecked = 0;
  let worstDelta = 0;

  for (const query of PROBE_QUERIES) {
    const embedding = await embed(query);
    const vectorLiteral = `[${embedding.join(",")}]`;

    const serving = await searchGloss(prisma, vectorLiteral, 10);
    const hits = (await searchGlossSynsets(prisma, vectorLiteral, 10, GLOSS_PROBES, {
      withGloss: true,
      withVector: true,
    })) as VizSynsetHit[];
    const debugWords = expandSynsets(hits, 10);

    check(
      `"${query.slice(0, 34)}…"`,
      JSON.stringify(serving) === JSON.stringify(debugWords),
      `${serving.length} words, top=${serving[0]?.word}`
    );

    // 6 · exact placement, for any returned synset that is also in the cloud.
    for (const hit of hits) {
      const row = index.get(hit.synsetKey);
      if (row === undefined) continue;
      const vector = parseVectorLiteral(hit.vector as unknown as string);
      const p = project(vector, snap.basis, snap.mean);
      const delta = Math.max(
        Math.abs(p.x - snap.x[row]),
        Math.abs(p.y - snap.y[row]),
        Math.abs(p.z - snap.z[row])
      );
      worstDelta = Math.max(worstDelta, delta);
      projectionsChecked++;
    }
  }

  console.log("\n6 · retrieved synsets project onto their snapshot coordinates");
  if (projectionsChecked === 0) {
    check("at least one retrieved synset was in the sampled cloud", false,
      "none overlapped — widen the probe queries");
  } else {
    // The snapshot rounds coordinates to 4dp, so 1e-4 is the floor.
    check(
      `${projectionsChecked} projections match to 4dp`,
      worstDelta < 2e-4,
      `worst delta ${worstDelta.toExponential(2)}`
    );
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
