/**
 * Minimal Open English WordNet (WN-LMF 1.3 XML) reader — RD-17 step 2.
 *
 * WHY IT EXISTS AND WHY IT IS NOT A BUILD INPUT. RD-17's step 2 says to try the
 * cheap source before the expensive one: OEWN is the maintained successor to
 * Princeton WordNet 3.0 with the same synset/gloss structure, so adopting it
 * would change only the reader in `wordnet.ts` and cost roughly zero extra
 * storage. The delta was measured (see `probe-oewn-delta.ts`) and it is not the
 * ticket, so this stays a probe. Do not wire it into `build-gloss-index.ts`
 * without reading METHODS §15 first — OEWN uses its own synset identifiers, so
 * adopting it re-keys the whole index and orphans every committed run.
 *
 * The file is ~100 MB of XML unpacked. A DOM parse would be gratuitous: the
 * format is machine-generated with one element per line and fixed attribute
 * order, so the three regexes below read it in one pass. If the upstream
 * formatting ever changes this will silently return less than it should, which
 * is why `readOewn()` asserts non-trivial counts before returning.
 */
import fs from "node:fs";
import zlib from "node:zlib";

export type OewnSynset = {
  /** OEWN's own id, e.g. `oewn-08242255-n`. NOT a WordNet 3.0 offset. */
  id: string;
  pos: string;
  definition: string;
  lemmas: string[];
};

/** XML entities the LMF export actually emits. */
function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Accepts the `.xml` or the shipped `.xml.gz` directly. */
function readXml(file: string): string {
  const raw = fs.readFileSync(file);
  return (file.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8");
}

export function readOewn(file: string): OewnSynset[] {
  const xml = readXml(file);

  // <LexicalEntry ...><Lemma writtenForm="x" partOfSpeech="n"/><Sense id=".." synset="oewn-..-n"/>...
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
    // Underscores are the file's word separator, as in WordNet's own data files.
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

  // <Synset id=".." ... partOfSpeech="n" ...><Definition>text</Definition>
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

  // A formatting change upstream would show up as a near-empty parse rather
  // than as an error, and a near-empty parse reads as "OEWN adds nothing".
  if (synsets.length < 100_000 || bySynset.size < 100_000) {
    throw new Error(
      `OEWN parse looks wrong: ${synsets.length} synsets, ${bySynset.size} with members. ` +
        `Expected ~120k of each. The XML layout probably changed.`
    );
  }
  return synsets;
}

/** Every distinct lemma in the lexicon, spaces restored. */
export function oewnLemmas(synsets: OewnSynset[]): Set<string> {
  const out = new Set<string>();
  for (const s of synsets) for (const l of s.lemmas) out.add(l);
  return out;
}
