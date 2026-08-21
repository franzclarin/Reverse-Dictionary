/**
 * Minimal WordNet 3.0 reader over the `wordnet-db` data files.
 *
 * Build-time only: this parses the dictionary files shipped by `wordnet-db` to
 * build the gloss index and to audit coverage. It is never imported by the app,
 * and it never touches `eval/sets/` — the eval set is hand-authored and stays
 * blind to every gloss in here.
 *
 * File formats (see `wndb(5)`):
 *   index.POS : lemma pos synset_cnt p_cnt [ptr...] sense_cnt tagsense_cnt offset...
 *   data.POS  : offset lex_filenum ss_type w_cnt word lex_id [...] | gloss
 * Both use `_` where a lemma contains a space, and both open with 29 licence
 * lines starting "  ".
 */
import fs from "node:fs";
import path from "node:path";

export type Pos = "noun" | "verb" | "adj" | "adv";

export const POS_LIST: Pos[] = ["noun", "verb", "adj", "adv"];

export function dictDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require("wordnet-db") as { path: string };
  return db.path;
}

function readDataLines(file: string): string[] {
  return fs
    .readFileSync(file, "latin1")
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("  "));
}

/** Lemmas for one part of speech, spaces restored from underscores. */
export function readIndex(pos: Pos): string[] {
  const lines = readDataLines(path.join(dictDir(), `index.${pos}`));
  const lemmas: string[] = [];
  for (const line of lines) {
    const space = line.indexOf(" ");
    if (space === -1) continue;
    lemmas.push(line.slice(0, space).replace(/_/g, " "));
  }
  return lemmas;
}

export type Sense = {
  /** WordNet synset offset, unique within a part of speech. */
  offset: string;
  pos: Pos;
  /** Every lemma in this synset, spaces restored. */
  words: string[];
  /** Definition text, with any example sentences stripped off. */
  gloss: string;
  /** Quoted example sentences that followed the definition, if any. */
  examples: string[];
};

/**
 * All synsets for one part of speech.
 *
 * A WordNet gloss is `definition; "example one"; "example two"`. The examples
 * are split out rather than dropped so Phase E can test indexing with and
 * without them.
 */
export function readSenses(pos: Pos): Sense[] {
  const lines = readDataLines(path.join(dictDir(), `data.${pos}`));
  const senses: Sense[] = [];

  for (const line of lines) {
    const bar = line.indexOf("|");
    if (bar === -1) continue;

    const fields = line.slice(0, bar).trim().split(/\s+/);
    const offset = fields[0];
    const wordCount = parseInt(fields[3], 16);
    if (!Number.isFinite(wordCount)) continue;

    // Words start at field 4, each followed by a lex_id.
    const words: string[] = [];
    for (let i = 0; i < wordCount; i++) {
      const w = fields[4 + i * 2];
      if (w) words.push(w.replace(/_/g, " "));
    }

    const raw = line.slice(bar + 1).trim();
    const parts = raw.split(";").map((p) => p.trim());
    const definition: string[] = [];
    const examples: string[] = [];
    for (const part of parts) {
      if (/^["']/.test(part)) examples.push(part.replace(/^["']|["']$/g, ""));
      else if (examples.length === 0) definition.push(part);
    }

    senses.push({
      offset,
      pos,
      words,
      gloss: definition.join("; ").trim(),
      examples,
    });
  }

  return senses;
}
