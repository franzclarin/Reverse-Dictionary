/**
 * BERT WordPiece tokenization, in the browser, for the /explain page (RD-18).
 *
 * WHY THIS EXISTS RATHER THAN `AutoTokenizer`. The acceptance criterion is that
 * the sub-words on screen are the tokenizer's actual output and not a
 * whitespace split dressed up as sub-words. Importing `@xenova/transformers`
 * into a client component would satisfy that but drag ~1 MB of JS and the
 * onnxruntime-web loader into the bundle to do the work of ~100 lines — for a
 * page whose whole point is that the 86 MB model never reaches a browser.
 *
 * So this reimplements the exact configuration recorded in the model's own
 * `tokenizer.json`: `BertNormalizer` (clean_text, handle_chinese_chars,
 * strip_accents = null → follows lowercase, lowercase) → `BertPreTokenizer`
 * (whitespace and punctuation) → `WordPiece` (greedy longest-match-first, `##`
 * continuation, `[UNK]` fallback) → `[CLS]` … `[SEP]`, truncated at 256.
 *
 * **A reimplementation is only honest if it is checked.** `scripts/verify-viz-snapshot.ts`
 * runs this against the real `AutoTokenizer` over a corpus of phrases and
 * asserts the token ids are identical. If that check is ever removed, this file
 * becomes exactly the plausible-looking split the ticket forbids.
 */

export type WordPieceConfig = {
  vocab: string[];
  unkToken: string;
  continuingSubwordPrefix: string;
  maxInputCharsPerWord: number;
  maxLength: number;
  lowercase: boolean;
  stripAccents: boolean;
  clsToken: string;
  sepToken: string;
};

export type Token = {
  text: string;
  id: number;
  /** A `##` continuation of the previous piece — the visually interesting case. */
  continuation: boolean;
  /** `[CLS]` / `[SEP]`. They are pooled with everything else; the page says so. */
  special: boolean;
  /** True when the word fell out of the 30,522-piece vocabulary entirely. */
  unknown: boolean;
};

export type Tokenization = {
  tokens: Token[];
  /** Set when the input exceeded `maxLength` and the tail was dropped. */
  truncated: boolean;
};

const CONTROL = /^[\p{Cc}\p{Cf}]$/u;
const WHITESPACE = /^[\s ]$/u;
const PUNCTUATION =
  /^[!-/:-@[-`{-~\p{P}]$/u;

function isChineseChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

/** `BertNormalizer`, in the order the Rust implementation applies its steps. */
function normalize(text: string, config: WordPieceConfig): string {
  let out = "";
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd) continue;
    if (char === "\t" || char === "\n" || char === "\r") {
      out += " ";
      continue;
    }
    if (CONTROL.test(char)) continue;
    out += isChineseChar(cp) ? ` ${char} ` : char;
  }

  // strip_accents is null in tokenizer.json, which means "follow lowercase".
  if (config.stripAccents) out = out.normalize("NFD").replace(/\p{Mn}/gu, "");
  if (config.lowercase) out = out.toLowerCase();
  return out;
}

/** `BertPreTokenizer`: split on whitespace, then peel punctuation off as words. */
function preTokenize(text: string): string[] {
  const words: string[] = [];
  let current = "";

  const flush = () => {
    if (current) words.push(current);
    current = "";
  };

  for (const char of text) {
    if (WHITESPACE.test(char)) {
      flush();
    } else if (PUNCTUATION.test(char)) {
      flush();
      words.push(char);
    } else {
      current += char;
    }
  }
  flush();
  return words;
}

/**
 * Greedy longest-match-first over the vocabulary, the WordPiece algorithm.
 *
 * Note the failure mode this encodes: if ANY piece of a word is unmatchable the
 * WHOLE word becomes `[UNK]`, not just the offending span.
 */
function wordPiece(word: string, lookup: Map<string, number>, config: WordPieceConfig): Token[] {
  const unkId = lookup.get(config.unkToken)!;
  const unk = (text: string): Token[] => [
    { text: config.unkToken, id: unkId, continuation: false, special: false, unknown: true },
  ];

  const chars = Array.from(word);
  if (chars.length > config.maxInputCharsPerWord) return unk(word);

  const pieces: Token[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let matched: { text: string; id: number } | null = null;

    while (start < end) {
      const substr = chars.slice(start, end).join("");
      const candidate = start > 0 ? config.continuingSubwordPrefix + substr : substr;
      const id = lookup.get(candidate);
      if (id !== undefined) {
        matched = { text: candidate, id };
        break;
      }
      end--;
    }

    if (!matched) return unk(word);
    pieces.push({
      text: matched.text,
      id: matched.id,
      continuation: start > 0,
      special: false,
      unknown: false,
    });
    start = end;
  }
  return pieces;
}

export function createTokenizer(config: WordPieceConfig) {
  const lookup = new Map<string, number>();
  config.vocab.forEach((piece, id) => lookup.set(piece, id));

  return function tokenize(text: string): Tokenization {
    const words = preTokenize(normalize(text, config));

    const body: Token[] = [];
    for (const word of words) body.push(...wordPiece(word, lookup, config));

    const special = (t: string): Token => ({
      text: t,
      id: lookup.get(t)!,
      continuation: false,
      special: true,
      unknown: false,
    });

    // Post-process FIRST, then hard-truncate — which is what Transformers.js
    // does, and it has a genuinely surprising consequence: an over-long input
    // loses its [SEP], because the cut lands before the token that was appended
    // to close the sequence. Reserving two slots up front would be the tidier
    // algorithm and would NOT match what the server feeds the encoder.
    //
    // Unreachable from /api/lookup in practice — the route caps queries at 500
    // characters — but the page claims these are the real sub-words, so this
    // follows the real behaviour rather than the sensible one.
    const all = [special(config.clsToken), ...body, special(config.sepToken)];
    const truncated = all.length > config.maxLength;

    return { tokens: truncated ? all.slice(0, config.maxLength) : all, truncated };
  };
}
