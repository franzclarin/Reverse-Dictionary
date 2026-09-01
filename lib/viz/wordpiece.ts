// Chopping a phrase into the word-pieces the model actually reads, in the
// browser. /explain shows these, so they must be the real ones — this is a
// hand-written copy of the model's rules, rather than shipping the whole model
// library to the browser for a hundred lines of work.
//
// A copy is only trustworthy if it is checked: `scripts/verify-viz-snapshot.ts`
// compares it against the real thing. Do not remove that check.

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
  /** This piece continues the word before it, rather than starting a new one. */
  continuation: boolean;
  /** A marker the model adds around the phrase. Counted like any other piece. */
  special: boolean;
  /** True when the model has never seen this word and gives up on it. */
  unknown: boolean;
};

export type Tokenization = {
  tokens: Token[];
  /** Set when the phrase was too long and the end was cut off. */
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

/** Tidy the text up — same steps, same order, as the real tokenizer. */
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

  // The model's settings tie accent-stripping to lowercasing.
  if (config.stripAccents) out = out.normalize("NFD").replace(/\p{Mn}/gu, "");
  if (config.lowercase) out = out.toLowerCase();
  return out;
}

/** Split on spaces, then peel punctuation off into words of its own. */
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

/** Match the longest piece the model knows, then repeat on what's left. */
// If any part of a word can't be matched, the whole word is given up on.
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

    // Add the end marker first, then cut — so an over-long phrase loses that
    // marker. Tidier orderings exist, but this is what the real tokenizer does,
    // and matching it is the point.
    const all = [special(config.clsToken), ...body, special(config.sepToken)];
    const truncated = all.length > config.maxLength;

    return { tokens: truncated ? all.slice(0, config.maxLength) : all, truncated };
  };
}
