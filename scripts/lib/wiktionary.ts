// Reads the Wiktionary data, and — the actual work — decides which entries to
// keep. That decision lives in code rather than a document because it sets both
// the storage bill and how much noise search has to sift. Every rule is
// separate and counted separately, so the build can report how many entries
// each one removed. A filter nobody can attribute is a filter nobody can argue
// with.
//
// The source is one entry per line, each holding a word, its part of speech and
// its meanings — which maps straight onto a row in our index.
//
// Wiktionary is share-alike licensed. The attribution below is recorded and
// must travel with any index built from these rows.
//
// Two things deliberately NOT filtered on. Rarity: the frequency table we have
// contains none of `petrichor`, `hangry` or `doomscrolling`, so filtering by it
// would remove exactly the words worth adding. Informality: slang and internet
// words are the payload, and dropping them would look like quality control
// while deleting the point of the exercise.

/** The credit that has to travel with every row built from this source. */
export const LICENCE =
  "English Wiktionary, via the Kaikki.org wiktextract extraction. " +
  "Text is CC BY-SA 4.0 / GFDL: attribution and share-alike both apply.";

export const SOURCE_URL =
  "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl";

/** Bump this whenever a rule below changes; it gets recorded with each run. */
export const FILTER_VERSION = "rd17.2";

/** The four kinds of word the index holds: nouns, verbs, adjectives, adverbs. */
// The source has many more — names, prepositions, numbers — but nobody
// describes those to a reverse dictionary.
export const KEPT_POS = new Set(["noun", "verb", "adj", "adv"]);

/** Marks an entry that just points at another word rather than meaning something. */
// "Plural of cat" is a dead end with no answer behind it. Slang and internet
// words are deliberately not in this list — they are what we came for.
export const FORM_TAGS = new Set([
  "form-of",
  "alt-of",
  "alternative",
  "abbreviation",
  "initialism",
  "acronym",
  "misspelling",
  "plural",
  "singular",
  "past",
  "participle",
  "comparative",
  "superlative",
  "romanization",
  "pronunciation-spelling",
  "eye-dialect",
  "clipping",
  "ellipsis",
  "contraction",
]);

/** Marks a meaning nobody would be describing today. */
// Long-dead senses are the worst kind of near-miss to have in the index.
// "Rare" is deliberately absent: `petrichor` and `limerence` are rare.
export const DEAD_TAGS = new Set(["obsolete", "archaic", "dated", "dialectal"]);

/** Definitions that are really just cross-references written out in words. */
// The tags above catch most of these, but the source doesn't always set them.
export const SHELL_GLOSS =
  /^(alternative|obsolete|archaic|dated|nonstandard|informal|common|eye)?\s*(spelling|form|misspelling|pronunciation|romanization)\s+of\b/i;

export const INFLECTION_GLOSS =
  /^(plural|singular|past|present|simple past|gerund|inflection|comparative|superlative|third-person|participle|abbreviation|initialism|acronym|clipping|ellipsis|synonym|antonym|obsolete form|used other than|only used in|see\b)/i;

/** The same shape test the main index uses. */
// Multi-word entries are kept: "deja vu" is a legitimate answer.
export function isJunkSurface(word: string): boolean {
  return /^[A-Z]/.test(word) || /[0-9]/.test(word) || /[^A-Za-z '-]/.test(word);
}

/** Shortest definition worth keeping, in characters. */
// "A small fish." says almost nothing against a twelve-word description, and
// there are a great many like it. This is the one judgement call in the filter,
// so it is named and reported rather than buried inside a condition.
export const MIN_GLOSS_CHARS = 20;

/** How many meanings to keep per word and part of speech. */
export const MAX_SENSES_PER_ENTRY = 4;

// ------------------------------------------------------------------ shapes

export type KaikkiSense = {
  glosses?: string[];
  raw_glosses?: string[];
  tags?: string[];
  form_of?: unknown;
  alt_of?: unknown;
};

export type KaikkiEntry = {
  word?: string;
  pos?: string;
  lang_code?: string;
  senses?: KaikkiSense[];
};

/** One row for the index, the same shape the main table uses. */
export type SupplementRow = {
    /** A key that can never clash with the main dictionary's keys. */
  key: string;
  pos: string;
  gloss: string;
    /** Always one word: this source has no groups of synonyms. */
  lemmas: string[];
  source: "wiktionary";
};

/** Why an entry was rejected — one counter per rule, so the filter is auditable. */
export type RejectReason =
  | "lang"
  | "pos"
  | "surface"
  | "form_ref"
  | "form_tag"
  | "dead_tag"
  | "no_gloss"
  | "shell_gloss"
  | "short_gloss"
  | "sense_cap"
  | "duplicate"
  | "already_answerable";

export type FilterCounts = Record<RejectReason | "kept", number>;

/** State the filter carries between entries. */
// The two counters answer different questions — "have I indexed this exact
// meaning already?" and "how many meanings of this word have I emitted?" —
// and merging them once produced thousands of clashing keys.
export type FilterState = {
  seen: Set<string>;
  senseIndex: Map<string, number>;
};

export function emptyState(): FilterState {
  return { seen: new Set(), senseIndex: new Map() };
}

export function emptyCounts(): FilterCounts {
  return {
    lang: 0,
    pos: 0,
    surface: 0,
    form_ref: 0,
    form_tag: 0,
    dead_tag: 0,
    no_gloss: 0,
    shell_gloss: 0,
    short_gloss: 0,
    sense_cap: 0,
    duplicate: 0,
    already_answerable: 0,
    kept: 0,
  };
}

/** Clean up one definition. */
// Uses the plain text, not the version prefixed with "(transitive)" and the
// like: that prefix is a label, not meaning, and indexing it would push the
// word "transitive" into every transitive verb.
export function cleanGloss(sense: KaikkiSense): string {
  const text = (sense.glosses ?? [])[0] ?? "";
  return text.replace(/\s+/g, " ").trim();
}

/** Run the filter over one entry, keeping what survives and tallying the rest. */
// Passing a test for "the index can already answer this" switches between the
// two variants being compared.
export function filterEntry(
  entry: KaikkiEntry,
  counts: FilterCounts,
  state: FilterState,
  isAnswerable?: (word: string) => boolean
): SupplementRow[] {
  const { seen, senseIndex } = state;
  const word = (entry.word ?? "").trim();
  const pos = entry.pos ?? "";

  if (entry.lang_code !== "en") {
    counts.lang++;
    return [];
  }
  if (!KEPT_POS.has(pos)) {
    counts.pos++;
    return [];
  }
  if (!word || isJunkSurface(word)) {
    counts.surface++;
    return [];
  }
  if (isAnswerable?.(word.toLowerCase())) {
    counts.already_answerable++;
    return [];
  }

  const rows: SupplementRow[] = [];
  for (const sense of entry.senses ?? []) {
    if (sense.form_of || sense.alt_of) {
      counts.form_ref++;
      continue;
    }
    const tags = sense.tags ?? [];
    if (tags.some((t) => FORM_TAGS.has(t))) {
      counts.form_tag++;
      continue;
    }
    if (tags.some((t) => DEAD_TAGS.has(t))) {
      counts.dead_tag++;
      continue;
    }
    const gloss = cleanGloss(sense);
    if (!gloss) {
      counts.no_gloss++;
      continue;
    }
    if (SHELL_GLOSS.test(gloss) || INFLECTION_GLOSS.test(gloss)) {
      counts.shell_gloss++;
      continue;
    }
    if (gloss.length < MIN_GLOSS_CHARS) {
      counts.short_gloss++;
      continue;
    }
    if (rows.length >= MAX_SENSES_PER_ENTRY) {
      counts.sense_cap++;
      continue;
    }
    // The same word appears under several origins, each its own entry, and those
    // routinely repeat a definition word for word.
    const fingerprint = `${word.toLowerCase()} ${pos} ${gloss.toLowerCase()}`;
    if (seen.has(fingerprint)) {
      counts.duplicate++;
      continue;
    }
    seen.add(fingerprint);

    // Numbered across all of a word's entries, not restarted within each one.
    // Otherwise `cat` the animal and `cat` the command both claim the same key —
    // untidy in a test file, but silent data loss on the way into the database,
    // where the second row would quietly overwrite the first.
    const slug = `${word.toLowerCase().replace(/ /g, "_")}:${pos}`;
    const n = senseIndex.get(slug) ?? 0;
    senseIndex.set(slug, n + 1);

    rows.push({
      key: `wikt:${slug}:${n}`,
      pos,
      gloss,
      lemmas: [word],
      source: "wiktionary",
    });
    counts.kept++;
  }
  return rows;
}
