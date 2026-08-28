/**
 * The cross-encoder rerank stage (RD-12) — offline harness only.
 *
 * Retrieval is a BI-encoder: the query and every gloss are embedded separately
 * and compared by cosine, so the model never sees the two texts together. A
 * CROSS-encoder reads `(query, gloss)` as one sequence and scores the pair
 * directly. It is far too slow to run over 117,791 synsets, and exactly
 * affordable over the top 50 that retrieval already found.
 *
 * The measured opportunity this exists to attack (`eval/runs/prod_gloss_shipped.json`,
 * authored reachable slice, n=287): the target is inside the top 100 for 77.0%
 * of queries but at rank 1 for only 24.0%. The 53 points in between are already
 * retrieved and merely mis-ranked. The remaining 23.0% is never retrieved at any
 * depth and NO reranker reaches it — that slice belongs to RD-09/RD-14/RD-15.
 *
 * This module scores; it does not retrieve and it does not decide order. The
 * ordering policy lives in `scripts/eval.ts` so the tie-break is written down in
 * one place (see METHODS §12 for why that matters here).
 */
import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@xenova/transformers";
import type { GlossSynsetHit } from "../../lib/glossSearch";

/**
 * Point Transformers.js at the HF CDN for this module's models.
 *
 * `env` is a PROCESS-WIDE SINGLETON and this is its THIRD consumer:
 * `lib/embedder.ts` pins local-only (`allowRemoteModels = false`, RD-11) so the
 * production model is read from the bundle, and `scripts/lib/embedModel.ts`
 * pins remote for the base-model eval cells. When two of them set it at module
 * scope, whichever module body evaluated last silently won and broke the other
 * — that is the bug that produced "both local and remote models are disabled"
 * in `eval:prod`. Adding a third consumer makes that failure MORE likely, not
 * less, so this is configured immediately before use and never at module scope.
 *
 * Safe because the harness runs sequentially — one model loaded at a time,
 * awaited — so no two loads interleave. If that ever changes this needs a lock
 * rather than a call-site assignment.
 */
function configureRemoteModelEnv(): void {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
}

/**
 * The off-the-shelf cross-encoder measured first, per RD-12's "start
 * off-the-shelf" rule: establish whether the architecture helps at all before
 * anyone scopes a fine-tune, and pay a day rather than weeks to find out.
 *
 * `ms-marco-MiniLM-L-6-v2` has a SINGLE-logit regression head (`config.json`
 * carries one label, `LABEL_0`), so the relevance score is `logits[i][0]` raw.
 * There is no softmax and no positive class to select — treating it as a
 * 2-class classifier would silently score noise.
 */
export const DEFAULT_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/** The second architecture point: same family, 12 layers instead of 6. */
export const LARGE_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-12-v2";

/**
 * THE SWEEP, AND THE RESULT: no shortlist depth was chosen, because none won.
 *
 * Recorded here the way `GLOSS_PROBES` records its sweep in `lib/glossSearch.ts`
 * — measured values in the file that would have to act on them. There is
 * deliberately no `RERANK_DEPTH` constant beside this: a named production depth
 * would imply a shipped stage, and nothing here ships.
 *
 * Lenient Recall@1, authored reachable slice (n=287), frozen set v1, gloss index
 * at probes=40. **Retrieval alone scores 24.0%** — that is the number to beat:
 *
 *   rerank depth              10      25      50     100     echo@100
 *   L-6,  gloss             21.6    19.9    20.6    20.2       15.2%
 *   L-6,  lemma-gloss       23.3    22.6    22.3    21.6       21.4%
 *   L-12, gloss             24.4    22.6    23.0    22.0       15.0%
 *
 * Three things this table says, none of which were guesses going in:
 *
 *   1. **Every cell loses**, and the paired tests agree: L-6 -3.8pp
 *      (33 regressions / 22 wins, p = 0.18), lemma-gloss -2.4pp (30/23,
 *      p = 0.41), L-12 -2.1pp (27/21, p = 0.47). Not noise around zero either —
 *      the cross-encoder moves ~50 of 287 queries per run, roughly evenly in
 *      both directions. It has opinions; they are not better opinions.
 *   2. **Recall falls as depth rises.** More candidates to reorder makes it
 *      worse, which is the signature of a scorer whose ranking is close to
 *      uninformative on this distribution: every extra candidate is another
 *      chance to promote something wrong above a correct answer retrieval had
 *      already placed well.
 *   3. **The lemma-gloss variant buys its partial recovery with echo**, exactly
 *      as Phase E predicted and RD-12 was told to check rather than assume:
 *      echo climbs monotonically with depth (16.1 / 18.6 / 20.6 / 21.4%)
 *      against the gloss variant's flat ~15% and the baseline's 14.5%. Showing
 *      the model the answer word lets it match the query's surface again — the
 *      precise defect RD-02 removed, reintroduced one stage later.
 *
 * The cause is visible in the scores. For "something you did wrong without ever
 * meaning to do it" (target `mistake`, retrieved at rank 1) the cross-encoder
 * ranks "something done or paid in expiation of a wrong" ABOVE "a wrong action
 * attributable to bad judgment or ignorance". It is scoring lexical relevance,
 * because MS MARCO is a web-passage relevance task and that is what transfers.
 * A reverse-dictionary query is a DESCRIPTION and a gloss is a DEFINITION; the
 * two are related by paraphrase, not by term overlap.
 *
 * See METHODS §13 for the full write-up, the fusion control
 * (`scripts/probe-rerank-fusion.ts`), and why this is a null result under §9a
 * rather than a case for tuning.
 */
export const RERANK_FINDING =
  "RD-12 (2026-08-28): measured and REJECTED. Off-the-shelf ms-marco cross-encoders " +
  "score below plain retrieval at every shortlist depth (best 24.4% vs 24.0% lenient " +
  "R@1, every paired test negative), and the lemma-gloss variant recovers ground only " +
  "by reintroducing echo. Null result under METHODS 9a; the stage is NOT served. " +
  "See METHODS 13 before re-running this experiment.";

/**
 * What text the cross-encoder is shown for each candidate.
 *
 *   gloss        the definition alone. PRIMARY, and the variant RD-12 mandates:
 *                the index has been synset-keyed gloss text since RD-02, and
 *                feeding a bare lemma would recreate the "12-word description
 *                against a 1-token document" mismatch RD-02 exists to have
 *                fixed — inside the reranker instead of inside the index.
 *   lemma-gloss  "<lemma>: <definition>". Measured, not assumed: Phase E already
 *                found the lemma prefix reintroduces the echo being removed.
 */
export type RerankInput = "gloss" | "lemma-gloss";

/**
 * Render one candidate synset as the document half of the pair.
 *
 * `lemmas[0]` is WordNet's own first member (sense familiarity) — the stored
 * order, never a sorted one. Sorting it measured 2.5 points worse in RD-02.
 */
export function rerankText(kind: RerankInput, hit: GlossSynsetHit): string {
  return kind === "lemma-gloss" ? `${hit.lemmas[0]}: ${hit.gloss}` : hit.gloss;
}

type Tokenizer = (
  text: string[],
  options: { text_pair: string[]; padding: boolean; truncation: boolean }
) => Promise<Record<string, unknown>>;

type SequenceClassifier = (
  inputs: Record<string, unknown>
) => Promise<{ logits: { data: Float32Array | number[]; dims: number[] } }>;

type CrossEncoder = { tokenizer: Tokenizer; model: SequenceClassifier };

const cache = new Map<string, Promise<CrossEncoder>>();

function cacheKey(modelId: string, quantized: boolean): string {
  return `${modelId}::${quantized ? "q8" : "fp32"}`;
}

/**
 * Load (and memoise) a cross-encoder.
 *
 * Tokenizer + model directly rather than `pipeline("text-classification", ...)`:
 * the v2 text-classification pipeline does not accept `text_pair`, so it cannot
 * express a cross-encoder at all. The tokenizer does
 * (`node_modules/@xenova/transformers/src/tokenizers.js:2701-2727`).
 */
function getCrossEncoder(modelId: string, quantized: boolean): Promise<CrossEncoder> {
  const key = cacheKey(modelId, quantized);
  let existing = cache.get(key);
  if (!existing) {
    configureRemoteModelEnv();
    existing = (async () => {
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(modelId),
        AutoModelForSequenceClassification.from_pretrained(modelId, { quantized }),
      ]);
      return { tokenizer, model } as unknown as CrossEncoder;
    })();
    cache.set(key, existing);
    // Never leave a rejected promise cached: every later call in this process
    // would fail instantly with the same stale error. Same guard as
    // `scripts/lib/embedModel.ts` and `lib/embedder.ts`.
    existing.catch(() => {
      if (cache.get(key) === existing) cache.delete(key);
    });
  }
  return existing;
}

/** Load the model without scoring anything, so ONNX init never lands on query #1. */
export async function warmReranker(
  modelId: string = DEFAULT_RERANK_MODEL,
  quantized = false
): Promise<void> {
  await scorePairs(modelId, "warm up the reranker before any timing starts", ["a warm up document"], {
    quantized,
  });
}

export type ScoreOptions = {
  /** Load `onnx/model_quantized.onnx`. Unlike the embedder, this model HAS one. */
  quantized?: boolean;
  /** Pairs per forward pass. */
  batchSize?: number;
};

/**
 * Score one query against many documents, best-first ordering left to the caller.
 *
 * Returns the RAW logit per document. Ranking only needs a monotonic score, and
 * a sigmoid would add a saturating transform that loses resolution between two
 * strong candidates for no ranking benefit. (The serving path squashes it for
 * display; that is a presentation decision, not a scoring one.)
 */
export async function scorePairs(
  modelId: string,
  query: string,
  docs: string[],
  { quantized = false, batchSize = 32 }: ScoreOptions = {}
): Promise<number[]> {
  if (docs.length === 0) return [];

  const { tokenizer, model } = await getCrossEncoder(modelId, quantized);
  const out: number[] = [];

  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    // `text` and `text_pair` must be arrays of equal length — the tokenizer
    // throws rather than broadcasting a single query across many documents.
    const inputs = await tokenizer(Array(batch.length).fill(query), {
      text_pair: batch,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    // Shape is [batch, 1] for this head; read it as a flat run of scores.
    for (let j = 0; j < batch.length; j++) out.push(Number(logits.data[j]));
  }

  return out;
}
