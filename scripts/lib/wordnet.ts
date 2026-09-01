// Reads the WordNet dictionary files that ship with this project.
//
// Build-time only: used to build the search index and to check coverage. The
// app never imports it, and it never touches the test set — those questions are
// written by hand and stay blind to every definition in here.
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

/** Every word for one part of speech. */
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
    /** This meaning's id, unique within its part of speech. */
  offset: string;
  pos: Pos;
    /** Every word that shares this meaning. */
  words: string[];
    /** The definition, without any example sentences. */
  gloss: string;
    /** The example sentences that followed the definition, if any. */
  examples: string[];
};

/** Every meaning for one part of speech. */
// The examples are split off rather than thrown away, so indexing with and
// without them can both be tested.
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

        // The words start at the fourth field, each followed by an id.
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
