import { NextRequest, NextResponse } from "next/server";
import { embed, embedTokens } from "@/lib/embedder";
import { prisma } from "@/lib/prisma";
import {
  searchGloss,
  searchGlossSynsets,
  expandSynsets,
  GLOSS_PROBES,
  GLOSS_LISTS,
  type VizSynsetHit,
} from "@/lib/glossSearch";
import { parseVectorLiteral } from "@/lib/viz/projection";
import { runShadowLookup } from "@/lib/shadowLookup";
import {
  Subsystem,
  SubsystemError,
  describeError,
  formatErrorShape,
} from "@/lib/errors";

export const runtime = "nodejs";
// Kept at 60 as a safety ceiling, NOT because loading is slow: since RD-11 the
// model ships in the function bundle and loads in ~64ms. Lowering this would
// only turn a slow Neon query into a 504, and Vercel bills actual duration
// rather than the limit — so there is nothing to win by tightening it.
export const maxDuration = 60;

// Shadow logging survives the RD-02 cutover with its roles INVERTED: the gloss
// index is now the primary path, so the sampled shadow query runs against the
// old lemma index (VocabEmbedding) instead. The ShadowLookup columns keep their
// original meaning — `old*` is always the lemma index and `new*` always the
// gloss index — so rows logged before and after the cutover stay comparable and
// scripts/shadow-compare.ts needs no change.
//
// Kept on rather than removed because the soak gate was retired for lack of
// traffic, not because the question was answered: if this app ever does get
// traffic, the comparison becomes worth running retroactively. Sampled and
// fire-and-forget; flip to false to stop logging without touching anything else.
const SHADOW_LOOKUP_ENABLED = true;
const SHADOW_SAMPLE_RATE = 0.1;

type ResultRow = { word: string; similarity: number };

/**
 * Upper bound on `k`. It flows straight into `LIMIT $2`, and before RD-18 it was
 * unvalidated — a client could ask for the whole index. 100 is well above what
 * the UI requests (10, then +10 per "load more") and above /explain's shortlist.
 */
const MAX_K = 100;

/** Token vectors returned to the debug payload before it starts costing real bytes. */
const MAX_DEBUG_TOKENS = 64;

/**
 * The debug payload behind `{ debug: true }` — RD-18's /explain page.
 *
 * **Opt-in per request, and that is the whole safety property.** With `debug`
 * absent this route takes the identical branch it always has: `searchGloss()`,
 * whose SQL is byte-identical to the pre-RD-12 query. Nothing about the serving
 * path changes for the 100% of requests that do not ask for this.
 *
 * The debug branch does not reimplement retrieval — it calls the same
 * `searchGlossSynsets()` + `expandSynsets()` that `searchGloss()` composes, so
 * `results` is the same list of words either way. It only declines to throw the
 * synsets away.
 */
type DebugPayload = {
  queryVector: number[];
  /**
   * The real per-token vectors the query vector was pooled from — `/explain`
   * animates them averaging into one. Capped: a 500-character query can reach
   * ~130 tokens, and 130 x 384 floats is a response nobody asked for.
   */
  tokenVectors: number[][];
  tokenVectorsTruncated: boolean;
  synsets: {
    synsetKey: string;
    gloss: string;
    lemmas: string[];
    similarity: number;
    vector: number[];
  }[];
  probes: number;
  lists: number;
};

const SUBSYSTEM_MESSAGES: Record<Subsystem, string> = {
  model:
    "The embedding model could not be loaded. This is usually a temporary network problem reaching the model host — please try again in a moment.",
  database:
    "The word database is unreachable. Please try again in a moment.",
  unknown: "An unexpected error occurred.",
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query, k = 10, debug = false } = body as {
      query: string;
      k?: number;
      debug?: boolean;
    };

    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "query is required and must be a string" },
        { status: 400 }
      );
    }
    if (query.length > 500) {
      return NextResponse.json(
        { error: "query too long (max 500 characters)" },
        { status: 400 }
      );
    }
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
      return NextResponse.json(
        { error: `k must be an integer between 1 and ${MAX_K}` },
        { status: 400 }
      );
    }

    // Timed separately so a cold-start model download (seconds) is
    // distinguishable from an instant failure in the logs.
    const embedStartedAt = Date.now();
    // The debug branch takes ONE forward pass and derives the pooled vector from
    // the per-token output; `embedTokens()` documents why that is identical to
    // `embed()`. The serving path below is the untouched original call.
    let tokenVectors: number[][] = [];
    let embedding: number[];
    if (debug) {
      const encoded = await embedTokens(query);
      embedding = encoded.pooled;
      tokenVectors = encoded.tokenVectors;
    } else {
      embedding = await embed(query);
    }
    console.log(`[lookup] embed ok ms=${Date.now() - embedStartedAt} dims=${embedding.length}`);

    const vectorLiteral = `[${embedding.join(",")}]`;

    const dbStartedAt = Date.now();
    let rows: ResultRow[];
    let debugPayload: DebugPayload | undefined;
    try {
      // RD-02 cutover: search the synset-keyed gloss index rather than the bare
      // lemma index. Expansion semantics live in lib/glossSearch.ts and mirror
      // the eval cell this decision was made on — see that file's header before
      // changing anything about how synsets become words.
      //
      // VocabEmbedding is deliberately left populated and indexed as the
      // rollback path: reverting this call is the whole rollback, no data
      // migration involved.
      if (debug) {
        // RD-18: same two calls `searchGloss()` composes, with the synsets kept
        // instead of discarded. `GLOSS_PROBES` is passed only because the extra
        // columns live in the 5th positional argument — it is the same default
        // constant, not a tuned value, so this stays the served configuration.
        const hits = (await searchGlossSynsets(prisma, vectorLiteral, k, GLOSS_PROBES, {
          withGloss: true,
          withVector: true,
        })) as VizSynsetHit[];
        rows = expandSynsets(hits, k);
        debugPayload = {
          queryVector: embedding,
          tokenVectors: tokenVectors
            .slice(0, MAX_DEBUG_TOKENS)
            // 4 decimals is well inside what a 384-cell column can render and
            // roughly halves the payload.
            .map((vector) => vector.map((value) => Math.round(value * 1e4) / 1e4)),
          tokenVectorsTruncated: tokenVectors.length > MAX_DEBUG_TOKENS,
          synsets: hits.map((hit) => ({
            synsetKey: hit.synsetKey,
            gloss: hit.gloss,
            lemmas: hit.lemmas,
            similarity: hit.similarity,
            // halfvec arrives as a "[a,b,...]" literal; the page projects it.
            vector: parseVectorLiteral(hit.vector as unknown as string),
          })),
          probes: GLOSS_PROBES,
          lists: GLOSS_LISTS,
        };
      } else {
        rows = await searchGloss(prisma, vectorLiteral, k);
      }
    } catch (error) {
      throw new SubsystemError("database", `pgvector query failed: ${describeError(error).message}`, {
        cause: error,
      });
    }
    console.log(`[lookup] db ok ms=${Date.now() - dbStartedAt} rows=${rows.length}`);

    // Fire-and-forget: never awaited, sampled, and never allowed to affect the
    // response or its latency. rows[0] is now the GLOSS index's top-1 (the new
    // primary); runShadowLookup queries the old lemma index itself. See
    // lib/shadowLookup.ts for what's logged and why.
    // `!debug`: the shadow log exists to compare the two indexes on ORGANIC
    // traffic. /explain's requests are someone poking at the explainer, so
    // counting them would quietly change what the log means.
    if (!debug && SHADOW_LOOKUP_ENABLED && rows.length > 0 && Math.random() < SHADOW_SAMPLE_RATE) {
      runShadowLookup(query, vectorLiteral, rows[0]).catch((error) => {
        console.error(`[lookup] shadow log failed (non-fatal): ${formatErrorShape(describeError(error))}`);
      });
    }

    // Embed + db time only. Real elapsed time, including any cold-start
    // model download: no fixed placeholder number gets shown in its place.
    const timingMs = Date.now() - embedStartedAt;

    // `debug` is added, never substituted: `results` and `timingMs` keep their
    // existing meaning and shape, so every current client is unaffected.
    return NextResponse.json(
      debugPayload ? { results: rows, timingMs, debug: debugPayload } : { results: rows, timingMs }
    );
  } catch (error) {
    const subsystem: Subsystem =
      error instanceof SubsystemError ? error.subsystem : "unknown";
    const shape = describeError(error);

    console.error(`[lookup] FAILED subsystem=${subsystem} ${formatErrorShape(shape)}`);
    if (shape.stack) console.error(`[lookup] stack: ${shape.stack}`);

    // Name the subsystem and the network code so the client never again sees a
    // bare "fetch failed". The hostname can identify a private database, so
    // it is only echoed outside production (the full shape is always in the
    // server logs regardless).
    const detailParts = [
      `${subsystem}: ${shape.message}`,
      shape.code ? `code=${shape.code}` : undefined,
      shape.hostname && process.env.NODE_ENV !== "production"
        ? `host=${shape.hostname}`
        : undefined,
    ].filter(Boolean);

    return NextResponse.json(
      {
        error: SUBSYSTEM_MESSAGES[subsystem],
        subsystem,
        code: shape.code,
        detail: detailParts.join(" "),
      },
      { status: 500 }
    );
  }
}
