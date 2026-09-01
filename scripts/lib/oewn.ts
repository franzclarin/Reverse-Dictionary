// Reads Open English WordNet, the maintained successor to the dictionary this
// project uses.
//
// This is a probe, not a build input. Switching to it was measured and turned
// out not to be worth it, and it numbers its entries differently — adopting it
// would renumber the whole index and invalidate every recorded result.
//
// The file is about 100 MB of XML, machine-generated with one item per line, so
// three patterns read it in a single pass. If that formatting ever changes this
// would quietly return too little, which is why the reader checks it got a
// sensible amount before handing anything back.
import fs from "node:fs";
import zlib from "node:zlib";

export type OewnSynset = {
    /** This source's own id, which is not the same as our dictionary's. */
  id: string;
  pos: string;
  definition: string;
  lemmas: string[];
};

/** The handful of escape codes this file format actually uses. */
function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Takes either the plain file or the compressed one. */
function readXml(file: string): string {
  const raw = fs.readFileSync(file);
  return (file.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8");
}

export function readOewn(file: string): OewnSynset[] {
  const xml = readXml(file);

    // Each entry gives a word, its part of speech, and the meanings it belongs to.
  const bySynset = new Map<string, string[]>();
  const entryRe =
    /<LexicalEntry[^>]*>([\s\S]*?)<\/LexicalEntry>/g;
  const lemmaRe = /<Lemma writtenForm="([^"]*)"/;
  const senseRe = /<Sense[^>]*\ssynset="([^"]*)"/g;

  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(xml))) {
    const body = entry[1];
    const lemmaMatch = lemmaRe.exec(body);
    if (!lemmaMatch) continue;
        // Underscores stand in for spaces, as in the original dictionary files.
    const lemma = unescapeXml(lemmaMatch[1]).replace(/_/g, " ");
    senseRe.lastIndex = 0;
    let sense: RegExpExecArray | null;
    while ((sense = senseRe.exec(body))) {
      const key = sense[1];
      const members = bySynset.get(key);
      if (members) members.push(lemma);
      else bySynset.set(key, [lemma]);
    }
  }

    // Each meaning gives its part of speech and its definition.
  const synsets: OewnSynset[] = [];
  const synsetRe = /<Synset\s+([^>]*)>([\s\S]*?)<\/Synset>/g;
  const defRe = /<Definition>([\s\S]*?)<\/Definition>/;
  let match: RegExpExecArray | null;
  while ((match = synsetRe.exec(xml))) {
    const attrs = match[1];
    const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
    if (!id) continue;
    const def = defRe.exec(match[2]);
    synsets.push({
      id,
      pos: /\bpartOfSpeech="([^"]*)"/.exec(attrs)?.[1] ?? "",
      definition: def ? unescapeXml(def[1]).trim() : "",
      lemmas: bySynset.get(id) ?? [],
    });
  }

    // A change to the file's format would show up as a nearly empty read rather
    // than as an error, and that reads as "this source adds nothing".
  if (synsets.length < 100_000 || bySynset.size < 100_000) {
    throw new Error(
      `OEWN parse looks wrong: ${synsets.length} synsets, ${bySynset.size} with members. ` +
        `Expected ~120k of each. The XML layout probably changed.`
    );
  }
  return synsets;
}

/** Every distinct word in the dictionary. */
export function oewnLemmas(synsets: OewnSynset[]): Set<string> {
  const out = new Set<string>();
  for (const s of synsets) for (const l of s.lemmas) out.add(l);
  return out;
}
