/**
 * Produce numbers from the LIVE model, so the Python side can be checked
 * against it.
 *
 * Python and production load the same model two different ways. If they ever
 * drift apart, every Python number quietly stops describing production, and
 * this is what catches that.
 *
 * It imports the real serving code rather than repeating its settings: copying
 * them here would defeat the check.
 *
 * Writes to a file rather than the screen, because the serving code prints a
 * line of its own and mixing the two would make the output unreadable.
 *
 *   npx tsx training/tools/embed_reference.ts /tmp/ref.json [text ...]
 */
import fs from "node:fs";
import { embed } from "../../lib/embedder";

/** Three kinds of text: a user's phrasing, a long one, and a dictionary
 *  definition. A single short string would not exercise enough of the model. */
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
