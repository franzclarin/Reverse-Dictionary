// A second model that re-sorts the shortlist. Offline experiment only —
// nothing here is used by the live site.
//
// Ordinary search compares the question and each definition separately, which
// is fast enough to run over the whole dictionary. This model reads a question
// and a definition together, which is far more careful and far too slow for
// more than the fifty or so results search already found.
//
// It was tried because the right answer is often somewhere in that shortlist
// but not at the top. It did not work — see the results below.
import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@xenova/transformers";
import type { GlossSynsetHit } from "../../lib/glossSearch";

/** Allow downloading models, which this file needs and the live app forbids. */
// These settings are global, so set them right before use, never at the top of
// a file: whichever file loads last would silently win and break the other.
// Safe only because models are loaded one at a time here.
function configureRemoteModelEnv(): void {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
}

/** The first ready-made model tried, before anyone scoped building one. */
// It reports a single raw score, not a choice between two options. Treating it
// as a yes/no classifier would silently rank noise.
export const DEFAULT_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/** The second one tried: same family, twice as deep. */
export const LARGE_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-12-v2";

/** How deep to re-sort. No value was chosen, because none of them won. */
// Every depth tried scored below plain search, and scored worse the deeper it
// went — the sign of a model whose opinion is close to worthless here. Showing
// it the answer word recovered a little ground, but only by bringing back the
// word-echoing problem the main index was rebuilt to remove.
//
// The reason shows in the scores: this model was trained to match web pages to
// questions, so it ranks by shared words. A question here is a *description*
// and a definition is a *definition* — related by rephrasing, not by overlap.
//
// There is deliberately no "chosen depth" constant beside this: naming one
// would imply something shipped, and nothing here does.
export const RERANK_FINDING =
  "RD-12 (2026-08-28): measured and REJECTED. Off-the-shelf ms-marco cross-encoders " +
  "score below plain retrieval at every shortlist depth (best 24.4% vs 24.0% lenient " +
  "R@1, every paired test negative), and the lemma-gloss variant recovers ground only " +
  "by reintroducing echo. Null result under METHODS 9a; the stage is NOT served. " +
  "See METHODS 13 before re-running this experiment.";

/** What text the second model is shown for each candidate. */
// Just the definition is the primary choice. Adding the word itself was
// measured rather than assumed, and it brings back the word-echoing problem.
export type RerankInput = "gloss" | "lemma-gloss";

/** Turn one candidate into the text the model reads. */
// Uses the stored word order, which puts the most familiar sense first.
// Never sort it — sorting measured worse.
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

/** Load a re-sorting model, once. */
// Built from its parts rather than the ready-made helper, because that helper
// cannot pass two texts at once, which is the whole point of this kind of model.
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
        // Forget a failed load, or every later call fails with the same stale error.
    existing.catch(() => {
      if (cache.get(key) === existing) cache.delete(key);
    });
  }
  return existing;
}

/** Load the model up front, so the first question isn't the slow one. */
export async function warmReranker(
  modelId: string = DEFAULT_RERANK_MODEL,
  quantized = false
): Promise<void> {
  await scorePairs(modelId, "warm up the reranker before any timing starts", ["a warm up document"], {
    quantized,
  });
}

export type ScoreOptions = {
    /** Load the smaller, faster weights. This model has them; the main one doesn't. */
  quantized?: boolean;
    /** How many pairs to score at a time. */
  batchSize?: number;
};

/**
/** Score one question against many candidates; the caller decides the order. */
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
        // Both sides must be lists of the same length; the tokenizer will not
        // repeat one question across many candidates by itself.
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
