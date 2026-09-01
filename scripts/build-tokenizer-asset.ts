/**
 * Pull out the small word-splitting file the /explain page needs in the browser.
 *
 * Reads the same settings file the server splits text with, and writes out just
 * the vocabulary and the rules.
 *
 * The original is mostly configuration the browser has no use for, and is more
 * than twice the size. The 86 MB model sitting beside it is never touched, here
 * or on the page.
 *
 * The input is downloaded, not committed, so run `npm run fetch-model` first.
 * The output IS committed — the page cannot render without it.
 *
 *   npx tsx scripts/build-tokenizer-asset.ts
 */
import fs from "node:fs";
import path from "node:path";
import type { WordPieceConfig } from "../lib/viz/wordpiece";

const SOURCE = path.resolve(
  process.cwd(),
  "models/franzclarin/ReverseDictionary/tokenizer.json"
);
const OUT_PATH = path.resolve(process.cwd(), "public/viz/wordpiece.json");

function main() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(
      `missing ${path.relative(process.cwd(), SOURCE)} — run \`npm run fetch-model\` first`
    );
  }

  const tokenizer = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  const model = tokenizer.model;
  if (model?.type !== "WordPiece") {
    throw new Error(`expected a WordPiece model, got ${model?.type}`);
  }

  const normalizer = tokenizer.normalizer ?? {};
  const lowercase = normalizer.lowercase !== false;

    // Flip it around into id order, so the page can look a piece up by number.
  const vocab: string[] = new Array(Object.keys(model.vocab).length);
  for (const [piece, id] of Object.entries(model.vocab as Record<string, number>)) {
    vocab[id] = piece;
  }
  if (vocab.some((v) => v === undefined)) throw new Error("vocabulary has id gaps");

  const config: WordPieceConfig = {
    vocab,
    unkToken: model.unk_token,
    continuingSubwordPrefix: model.continuing_subword_prefix,
    maxInputCharsPerWord: model.max_input_chars_per_word,
    maxLength: tokenizer.truncation?.max_length ?? 256,
    lowercase,
        // Unset means "follow lowercasing", the same default the real one uses.
    stripAccents: normalizer.strip_accents ?? lowercase,
    clsToken: "[CLS]",
    sepToken: "[SEP]",
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(config), "utf8");

  console.log(`\n  pieces          ${vocab.length.toLocaleString()}`);
  console.log(`  lowercase       ${config.lowercase}`);
  console.log(`  strip accents   ${config.stripAccents}`);
  console.log(`  max length      ${config.maxLength}`);
  console.log(
    `\n  wrote ${path.relative(process.cwd(), OUT_PATH)} ` +
      `(${(fs.statSync(OUT_PATH).size / 1e3).toFixed(0)} KB)\n`
  );
}

main();
