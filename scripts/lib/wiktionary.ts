/**
 * RD-17's Wiktionary source reader and — the actual work — its FILTER.
 *
 * The filter is committed as code rather than described in a ticket because it
 * determines both the storage bill and the distractor count, and it is the
 * parameter this ticket will be re-run against. Every rule below is exported
 * individually and counted individually, so `build-supplement.ts` can print how
 * many senses each one killed. A filter whose rules cannot be attributed is a
 * filter nobody can argue with.
 *
 * SOURCE. The Kaikki.org / `wiktextract` machine-readable extraction of English
 * Wiktionary: one JSON object per (word, pos, etymology) on its own line, each
 * carrying a `senses[]` array whose entries hold `glosses[]`, `tags[]`, and
 * `form_of` / `alt_of` back-references. That maps directly onto a
 * `GlossEmbedding` row — one sense, one gloss, one lemma.
 *
 * LICENCE. English Wiktionary is CC BY-SA. Anything built from these glosses
 * carries attribution *and* share-alike, which WordNet's licence does not
 * impose. `LICENCE` below is recorded into the supplement manifest and must
 * travel with any index that ships these rows.
 *
 * WHAT IS DELIBERATELY *NOT* FILTERED ON.
 *
 *   Frequency. Gating by `eval/data/zipf-en.tsv` is the obvious way to keep the
 *   list small, and it is wrong: that table is OpenSubtitles-derived and
 *   contains none of `petrichor`, `sonder`, `hangry`, `umami`, `saudade`,
 *   `doomscrolling`, `gaslighting` or `limerence`. A frequency gate removes
 *   precisely the words this ticket exists to add.
 *
 *   Informality. `slang`, `informal`, `colloquial`, `Internet` and `neologism`
 *   are KEPT. Those tags carry `hangry`, `doomscrolling`, `enshittification`
 *   and `mansplaining` — the payload. Dropping "low-register" senses would look
 *   like quality control and would delete the ticket.
 */

/** Attribution obligation that travels with every row built from this source. */
export const LICENCE =
  "English Wiktionary, via the Kaikki.org wiktextract extraction. " +
  "Text is CC BY-SA 4.0 / GFDL: attribution and share-alike both apply.";

export const SOURCE_URL =
  "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl";

/** Bump when any rule below changes. Recorded in the manifest and in run configs. */
export const FILTER_VERSION = "rd17.2";

/**
 * The four parts of speech the index already holds.
 *
 * Wiktionary's `pos` vocabulary is much wider (`name`, `intj`, `prep`, `num`,
 * `prefix`, `character`, ...). `name` is the proper-noun class the junk audit
 * already measured as 22.7% of the lemma index and 2.8% of results; the rest
 * are function words, which no reverse-dictionary query asks for.
 */
export const KEPT_POS = new Set(["noun", "verb", "adj", "adv"]);

/**
 * Tags that mark a sense as a pointer to another word rather than a meaning.
 *
 * `hangry` is `informal`; `doomscrolling` is `Internet`; neither is here. What
 * is here is the machinery of inflection and abbreviation: a row for "plural of
 * cat" is a distractor with no answer behind it.
 */
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

/**
 * Tags that mark a sense as one nobody would be describing.
 *
 * `obsolete` and `archaic` are the near-duplicate, long-dead senses RD-17's
 * risk section names as "the worst possible shape of distractor". `dated` and
 * `dialectal` are the same argument one notch weaker. `rare` is deliberately
 * NOT here: `petrichor` and `limerence` are rare in exactly that sense.
 */
export const DEAD_TAGS = new Set(["obsolete", "archaic", "dated", "dialectal"]);

/**
 * Glosses that are cross-references in prose.
 *
 * `form_of`/`alt_of` and the tags above catch most of these structurally, but
 * wiktextract does not always populate them, and the text form is unambiguous.
 */
export const SHELL_GLOSS =
  /^(alternative|obsolete|archaic|dated|nonstandard|informal|common|eye)?\s*(spelling|form|misspelling|pronunciation|romanization)\s+of\b/i;

export const INFLECTION_GLOSS =
  /^(plural|singular|past|present|simple past|gerund|inflection|comparative|superlative|third-person|participle|abbreviation|initialism|acronym|clipping|ellipsis|synonym|antonym|obsolete form|used other than|only used in|see\b)/i;

/**
 * The surface test, matching `junkPredicate()` in `scripts/lib/retrieval.ts`.
 *
 * Same three rules and the same deliberate omission: MULTI-WORD LEMMAS ARE
 * KEPT. `deja vu` and `stiff upper lip` are legitimate answers, and the vocab
 * audit found the multi-word class far too mixed to reject wholesale.
 */
export function isJunkSurface(word: string): boolean {
  return /^[A-Z]/.test(word) || /[0-9]/.test(word) || /[^A-Za-z '-]/.test(word);
}

/**
 * Shortest gloss worth indexing, in characters.
 *
 * A three-word gloss ("A small fish.") carries almost no signal against a
 * twelve-word description, and there are a great many of them. This is the one
 * threshold in the filter that is a judgement rather than a category, so it is
 * named and reported rather than buried in a condition.
 */
export const MIN_GLOSS_CHARS = 20;

/** Senses kept per (word, pos), in Wiktionary's own order. */
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

/** One row destined for the index: the same shape a `GlossEmbedding` row has. */
export type SupplementRow = {
  /** `wikt:<word>:<pos>:<n>` — namespaced so it can never collide with `pos:offset`. */
  key: string;
  pos: string;
  gloss: string;
  /** Always a single lemma. Wiktionary has no synsets, so there are no mates. */
  lemmas: string[];
  source: "wiktionary";
};

/** Why a sense was rejected. One counter per rule, so the filter is auditable. */
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

/**
 * Cross-entry state the filter carries.
 *
 * `seen` dedupes glosses; `senseIndex` makes keys unique. They are separate
 * because they answer different questions — "have I already indexed this exact
 * meaning?" and "how many senses of this headword have I emitted?" — and
 * conflating them is what produced 5,925 colliding keys.
 */
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

/**
 * Normalise one gloss.
 *
 * `glosses` is preferred over `raw_glosses` because the latter keeps the
 * parenthesised tag prefix ("(transitive) To look up in a dictionary"), and
 * that prefix is register metadata, not meaning — indexing it would put
 * "transitive" into the vector of every transitive verb.
 */
export function cleanGloss(sense: KaikkiSense): string {
  const text = (sense.glosses ?? [])[0] ?? "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Apply the filter to one entry, appending kept rows and tallying rejections.
 *
 * `isAnswerable` is the arm switch: pass a predicate for `wikt_new` (skip any
 * headword the index can already answer) and `undefined` for `wikt_all`.
 */
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
    // The same word can appear under several etymologies, each its own entry,
    // and homographs routinely repeat a gloss verbatim across them.
    const fingerprint = `${word.toLowerCase()} ${pos} ${gloss.toLowerCase()}`;
    if (seen.has(fingerprint)) {
      counts.duplicate++;
      continue;
    }
    seen.add(fingerprint);

    // Numbered ACROSS entries, not within one. English Wiktionary splits a
    // homograph into one entry per etymology — `cat` the animal, `cat` the Unix
    // command, `cat` the drug — and each would otherwise restart at 0 and emit
    // `wikt:cat:noun:0` twice. In a cell that is merely untidy; on the way into
    // Postgres it is silent data loss, because `ON CONFLICT ("synsetKey") DO
    // UPDATE` would make the second row overwrite the first and the table would
    // come back 5,925 rows short of the index that was measured.
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
