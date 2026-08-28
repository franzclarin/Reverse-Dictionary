/**
 * Extract the browser-side tokenizer asset for /explain (RD-18).
 *
 * Reads `models/franzclarin/ReverseDictionary/tokenizer.json` — the file the
 * server actually tokenizes with — and emits the slim subset the page needs:
 * the 30,522-piece vocabulary in id order plus the WordPiece settings.
 *
 * Why a derived asset rather than serving `tokenizer.json` itself: that file is
 * 695 KB of merges, decoder config and post-processor templates the browser has
 * no use for; the vocabulary alone is ~270 KB. The 86 MB `onnx/model.onnx`
 * sitting beside it is never referenced, here or on the page.
 *
 * Input lives under the gitignored `models/`, so run `npm run fetch-model`
 * first. The output IS committed — the page cannot render without it.
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

  // vocab is { piece: id }; invert it into id order so the page can look up by id.
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
    // null means "follow lowercase" — the same default the Rust normalizer uses.
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
