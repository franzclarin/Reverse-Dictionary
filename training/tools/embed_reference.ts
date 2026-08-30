/**
 * Emit reference query vectors from the PRODUCTION embedder, for the parity gate.
 *
 * RD-22's Python notebooks encode with sentence-transformers while production
 * serves ONNX through Transformers.js. Those are two runtimes loading two
 * artifacts of the same weights, and if they ever diverge, every Python number
 * silently stops describing production. `rdlib.parity.check_encoder()` shells
 * out to this file and compares.
 *
 * It imports `lib/embedder.ts` rather than re-deriving anything: the point is to
 * measure the encoder that actually serves `/api/lookup`, so a copy of its
 * settings here would defeat the check.
 *
 * Writes JSON to argv[2] rather than stdout, because `lib/embedder.ts` logs a
 * load line to stdout and mixing the two would make the output unparseable.
 *
 *   npx tsx training/tools/embed_reference.ts /tmp/ref.json [text ...]
 */
import fs from "node:fs";
import { embed } from "../../lib/embedder";

/**
 * Defaults span the three registers the project actually cares about: a
 * user-voice description, a long one, and a raw WordNet gloss. A single short
 * string would not exercise pooling over a realistic token count.
 */
const DEFAULT_TEXTS = [
  "the smell of rain on dry earth",
  "when you say a word so many times it stops sounding like a word",
  "a wrong action attributable to bad judgment or ignorance or inattention",
  "that feeling when you walk into a room and forget why you came in",
  "someone who pretends to hold beliefs they do not actually have",
];

async function main(): Promise<void> {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("usage: embed_reference.ts <out.json> [text ...]");
    process.exitCode = 1;
    return;
  }

  const texts = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_TEXTS;
  const out: Record<string, number[]> = {};
  for (const text of texts) out[text] = await embed(text);

  fs.writeFileSync(outPath, JSON.stringify(out), "utf8");
  console.error(`[embed_reference] wrote ${texts.length} vectors to ${outPath}`);
}

void main();
