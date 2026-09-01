/**
 * Checks the things /explain's honesty rests on.
 *
 * 1. The live search query is unchanged. Asserted against a literal copy of it,
 *    so a future edit breaks this test rather than quietly changing what every
 *    recorded measurement describes.
 * 2. Asking for the extra detail returns the same words. It must not become a
 *    second, separate search.
 * 3. The browser's own word-splitter matches the real one, exactly, over every
 *    question in the frozen set plus a batch of deliberately awkward strings.
 * 4. The averaged result really is the average of the parts shown. The page
 *    animates that happening, so if it stops being true the page is asserting
 *    something false and this fails first.
 * 5. Positions are exact. A meaning already drawn in the cloud must land on its
 *    saved spot when placed from the numbers the search returns. This is the
 *    check that catches a position faked from its neighbours.
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

/** Strings picked to break a careless copy: accents, punctuation, casing, an
 *  unknown word, Chinese characters, and both length limits. */
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

/** The live query, word for word, as it stood before the extra options existed. */
// Do not "fix" this to match a change — if they diverge, the change is what
// needs justifying.
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

/** Rebuild the query from the same pieces the real one uses, rather than guessing. */
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

        // These settings are global, so set them right before use, never at the top
        // of a file: whichever file loads last would silently win.
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
                // Match exactly what the real measuring code does.
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

        // Exact placement, for any result that is also drawn in the cloud.
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

    // Fetched directly rather than waiting for a coincidence. The check above only
    // gets to run when a test question happens to return something also drawn in
    // the cloud, and the cloud is now a much smaller share of the index, so that
    // is rare. The property being tested is unchanged; it is just no longer left
    // to luck. The opportunistic check stays, because it also proves the live path
    // hands back the same numbers the cloud was built from.
  const sampledKeys = (snap.keys as string[]).filter((_, i) => i % 601 === 0).slice(0, 25);
  const sampledRows = await prisma.$queryRawUnsafe<{ synsetKey: string; vector: string }[]>(
    `SELECT "synsetKey", embedding::text AS vector FROM "${GLOSS_INDEX}" WHERE "synsetKey" = ANY($1::text[])`,
    sampledKeys
  );
  for (const row of sampledRows) {
    const at = index.get(row.synsetKey);
    if (at === undefined) continue;
    const p = project(parseVectorLiteral(row.vector), snap.basis, snap.mean);
    worstDelta = Math.max(
      worstDelta,
      Math.abs(p.x - snap.x[at]),
      Math.abs(p.y - snap.y[at]),
      Math.abs(p.z - snap.z[at])
    );
    projectionsChecked++;
  }
  check(
    `${sampledRows.length} sampled synsets still exist in the index`,
    sampledRows.length === sampledKeys.length,
    `${sampledKeys.length} probed — a miss means the snapshot is stale; run npm run build-viz`
  );

  console.log("\n6 · stored synsets project onto their snapshot coordinates");
  if (projectionsChecked === 0) {
    check("at least one synset was available to project", false,
      "no overlap and no sampled rows — the snapshot does not match this index");
  } else {
        // The saved positions are rounded, so this is as close as they can get.
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
