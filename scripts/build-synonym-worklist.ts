/**
 * List candidate alternative answers for the test questions.
 *
 * Decisions are made on the forgiving score, which counts a listed synonym as
 * correct. Where no synonyms are listed that score collapses back into the strict
 * one, which undercounts badly wherever words tie — and most questions are
 * affected, so these are the highest-value rows in the review.
 *
 * Two rules this file obeys. It is derived from the dictionary's own structure
 * and never reads what any search returned: feeding results back into the answer
 * key would let the system grade its own homework. And it deliberately omits
 * definitions, because the reviewer is editing questions in the same sitting and
 * dictionary phrasing in front of them would contaminate that.
 *
 * This is a candidate list for a person. It writes nothing into the answer key —
 * the dictionary calling two words synonyms is not the same as one being an
 * acceptable answer for the other.
 *
 *   npx tsx scripts/build-synonym-worklist.ts
 */
import fs from "node:fs";
import path from "node:path";
import type { PoolManifest } from "./build-eval-pool";

const MANIFEST = path.resolve(process.cwd(), "eval/data/pool-manifest.json");
const OUT = path.resolve(process.cwd(), "eval/audit/synonym-worklist.txt");

const POS_NAME: Record<string, string> = {
  noun: "n.",
  verb: "v.",
  adj: "adj.",
  adv: "adv.",
};

type Entry = {
  target: string;
  senseKey: string;
  pos: string;
  mates: string[];
};

function main(): void {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as PoolManifest;

    // Each meaning, and the pooled words belonging to it.
  const bySynset = new Map<string, Set<string>>();
  for (const g of manifest.glosses) {
    if (!bySynset.has(g.senseKey)) bySynset.set(g.senseKey, new Set());
    bySynset.get(g.senseKey)!.add(g.word);
  }

    // Each answer, and the meanings it belongs to.
  const synsetsOf = new Map<string, string[]>();
  for (const g of manifest.glosses) {
    if (!synsetsOf.has(g.word)) synsetsOf.set(g.word, []);
    synsetsOf.get(g.word)!.push(g.senseKey);
  }

  const entries: Entry[] = [];
  for (const target of manifest.targets) {
    for (const senseKey of synsetsOf.get(target) ?? []) {
      const members = bySynset.get(senseKey);
      if (!members || members.size < 2) continue;
      const mates = [...members].filter((w) => w !== target).sort();
      if (!mates.length) continue;
      entries.push({ target, senseKey, pos: senseKey.split(":")[0], mates });
    }
  }

    // Biggest groups first: those are the questions where having no alternatives
    // listed costs the most.
  entries.sort((a, b) => b.mates.length - a.mates.length || a.target.localeCompare(b.target));

  const affected = new Set(entries.map((e) => e.target));
  const width = Math.max(...entries.map((e) => e.target.length), 10);

  const out: string[] = [];
  out.push("Candidate acceptable[] entries — synset-mates of the eval targets");
  out.push("=".repeat(72));
  out.push("");
  out.push(`Generated  ${new Date().toISOString()}`);
  out.push(`Source     WordNet synset membership, via eval/data/pool-manifest.json`);
  out.push(`Pool       ${manifest.scale} (${manifest.poolWords.toLocaleString()} words)`);
  out.push("");
  out.push(`Targets sharing a synset with another pooled word: ${affected.size}/${manifest.targets.length}`);
  out.push(`Target-synset groups listed:                       ${entries.length}`);
  out.push("");
  out.push("WHY THESE ROWS MATTER");
  out.push("  The decision rule resolves on lenient R@1, scored against acceptable[].");
  out.push("  Where acceptable[] is empty, lenient R@1 collapses back to strict R@1 —");
  out.push("  and strict R@1 is tie-deflated for gloss cells, because every word in a");
  out.push("  synset shares one gloss and therefore holds an identical vector. For");
  out.push("  these targets, rank 1 is decided by an arbitrary tie-break.");
  out.push("");
  out.push("HOW TO USE IT");
  out.push("  A candidate list, not a fill. Nothing here has been written into the set.");
  out.push("  WordNet proposing a synonym is not the same as it being an acceptable");
  out.push("  answer: 'oblivion' and 'limbo' are synset-mates, and whether one may");
  out.push("  stand in for the other is your judgement, not a lookup.");
  out.push("");
  out.push("  Gloss text is deliberately omitted. You are editing queries in the same");
  out.push("  session, and definitions in front of you would contaminate the blind");
  out.push("  drafting protocol (METHODS section 5). Bare words only, by design.");
  out.push("");
  out.push("  Sorted by synset size, largest first.");
  out.push("");
  out.push("-".repeat(72));
  out.push("");

  let lastSize = -1;
  for (const e of entries) {
    if (e.mates.length !== lastSize) {
      lastSize = e.mates.length;
      out.push("");
      out.push(`## ${lastSize} candidate${lastSize === 1 ? "" : "s"}`);
      out.push("");
    }
    out.push(`  ${e.target.padEnd(width)}  ${(POS_NAME[e.pos] ?? e.pos).padEnd(5)} ${e.mates.join(", ")}`);
  }

  out.push("");
  out.push("-".repeat(72));
  out.push(`${entries.length} groups covering ${affected.size} distinct targets.`);
  out.push("");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out.join("\n"), "utf8");

  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`  ${affected.size}/${manifest.targets.length} targets affected, ${entries.length} target-synset groups`);
  console.log(`  largest group: ${entries[0]?.mates.length} candidates (${entries[0]?.target})`);
  console.log(`  nothing was written into acceptable[] — this is a candidate list`);
}

main();
