/**
 * Pass 1 of the acceptable[] review: strip mechanical noise from the synonym
 * worklist, and stage the survivors for per-candidate judgement.
 *
 * PASS 1 IS DETERMINISTIC AND INVOLVES NO JUDGEMENT. It removes only what can
 * be decided by string shape:
 *
 *   A. candidates that are case-variants of the target itself (not synonyms,
 *      the same word)
 *   B. case-only duplicate groups among the candidates (Centre/center/centre
 *      collapse to one canonical form)
 *   C. pure symbol forms — a case group whose base is <= 3 characters and that
 *      has NO all-lowercase variant (Sn). Element symbols, nothing else.
 *
 * Rule C is the only one with any risk of over-reach, so every group it removes
 * is listed individually in the report rather than counted silently, and it is
 * deliberately narrow: a first version keyed on "short and capitalised
 * somewhere" also removed `sin` and `mar`, which are ordinary words. Unit
 * abbreviations that do have a lowercase form (cd) survive Pass 1 and are
 * rejected in Pass 2 on sense grounds instead — a judgement that can be read
 * and overridden, rather than a deletion that cannot.
 *
 * The working file it writes carries WordNet gloss text, so it goes to the
 * scratchpad, NOT to eval/audit/. Franz may still be editing query wording, and
 * dictionary phrasing in a file he is reading could bleed into that editing.
 * The deliverable paraphrases instead.
 *
 *   npx tsx scripts/prep-acceptable-review.ts --out <path>
 */
import fs from "node:fs";
import path from "node:path";
import type { PoolManifest } from "./build-eval-pool";

const MANIFEST = path.resolve(process.cwd(), "eval/data/pool-manifest.json");
const DRAFT = path.resolve(process.cwd(), "eval/sets/v1-draft.tsv");

export type SenseGroup = {
  senseKey: string;
  pos: string;
  gloss: string;
  examples: string[];
  candidates: string[];
};

export type ReviewRow = {
  target: string;
  query: string;
  hint: string;
  style: string;
  senses: SenseGroup[];
};

export type Pass1Report = {
  targetCaseVariants: string[];
  caseDuplicates: string[];
  symbolForms: string[];
  candidatesBefore: number;
  candidatesAfter: number;
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Rows of the draft TSV, keyed by target. Read-only; never written back. */
function readDraft(): Map<string, { query: string; hint: string; style: string }> {
  const lines = fs
    .readFileSync(DRAFT, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith('"#'));
  const header = lines[0].split("\t").map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const out = new Map<string, { query: string; hint: string; style: string }>();
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const target = (c[idx("target")] ?? "").trim();
    if (!target) continue;
    out.set(target.toLowerCase(), {
      query: (c[idx("query")] ?? "").trim(),
      hint: (c[idx("sense_hint")] ?? "").trim(),
      style: (c[idx("style")] ?? "").trim(),
    });
  }
  return out;
}

const hasUpper = (s: string) => /[A-Z]/.test(s);

function main(): void {
  const outPath = arg("--out") ?? path.join(process.cwd(), "acceptable-review.json");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as PoolManifest;
  const draft = readDraft();

  // synset -> pooled member words, and the gloss carried by that synset
  const members = new Map<string, Set<string>>();
  const glossOf = new Map<string, { gloss: string; examples: string[] }>();
  for (const g of manifest.glosses) {
    if (!members.has(g.senseKey)) members.set(g.senseKey, new Set());
    members.get(g.senseKey)!.add(g.word);
    if (!glossOf.has(g.senseKey)) glossOf.set(g.senseKey, { gloss: g.gloss, examples: g.examples });
  }

  const synsetsOf = new Map<string, string[]>();
  for (const g of manifest.glosses) {
    if (!synsetsOf.has(g.word)) synsetsOf.set(g.word, []);
    synsetsOf.get(g.word)!.push(g.senseKey);
  }

  const report: Pass1Report = {
    targetCaseVariants: [],
    caseDuplicates: [],
    symbolForms: [],
    candidatesBefore: 0,
    candidatesAfter: 0,
  };

  const rows: ReviewRow[] = [];

  for (const target of manifest.targets) {
    const meta = draft.get(target.toLowerCase());
    if (!meta) continue;

    const senses: SenseGroup[] = [];
    for (const senseKey of synsetsOf.get(target) ?? []) {
      const all = members.get(senseKey);
      if (!all || all.size < 2) continue;

      let candidates = [...all].filter((w) => w !== target);
      report.candidatesBefore += candidates.length;

      // A. case-variants of the target itself
      const kept: string[] = [];
      for (const c of candidates) {
        if (c.toLowerCase() === target.toLowerCase()) {
          report.targetCaseVariants.push(`${target}  <-  ${c}`);
        } else {
          kept.push(c);
        }
      }
      candidates = kept;

      // B/C. collapse case groups; strip short capitalised ones as symbols
      const groups = new Map<string, string[]>();
      for (const c of candidates) {
        const k = c.toLowerCase();
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(c);
      }

      const survivors: string[] = [];
      for (const [base, variants] of groups) {
        // Only a PURE symbol: short, and with no all-lowercase form at all.
        // An earlier draft stripped any short group containing a capitalised
        // variant, which also removed `sin` (for wickedness) and `mar` (for
        // defect) — real words that deserve a judgement. `cd` for the candela
        // sense survives to Pass 2 and is rejected there on sense grounds,
        // which is more transparent than deleting it with a regex.
        if (base.length <= 3 && variants.every(hasUpper)) {
          report.symbolForms.push(`${target} [${senseKey}]  <-  ${variants.join(", ")}`);
          continue;
        }
        // Canonical casing: prefer the all-lowercase form, else first alphabetically.
        const canonical = variants.find((v) => v === v.toLowerCase()) ?? [...variants].sort()[0];
        for (const v of variants) {
          if (v !== canonical) report.caseDuplicates.push(`${target}  <-  ${v} (kept ${canonical})`);
        }
        survivors.push(canonical);
      }

      if (!survivors.length) continue;
      survivors.sort();
      report.candidatesAfter += survivors.length;

      const g = glossOf.get(senseKey)!;
      senses.push({
        senseKey,
        pos: senseKey.split(":")[0],
        gloss: g.gloss,
        examples: g.examples,
        candidates: survivors,
      });
    }

    if (senses.length) {
      rows.push({ target, query: meta.query, hint: meta.hint, style: meta.style, senses });
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ report, rows }, null, 2), "utf8");

  const pairs = rows.reduce((s, r) => s + r.senses.reduce((t, g) => t + g.candidates.length, 0), 0);
  console.log("PASS 1 — mechanical strip (no judgement)\n");
  console.log(`  targets with candidates        ${rows.length}`);
  console.log(`  sense groups                   ${rows.reduce((s, r) => s + r.senses.length, 0)}`);
  console.log(`  candidates before              ${report.candidatesBefore}`);
  console.log(`  candidates after               ${report.candidatesAfter}  (${pairs} pairs to judge)`);
  console.log("");
  console.log(`  removed, case-variant of target ${report.targetCaseVariants.length}`);
  console.log(`  removed, case-only duplicate    ${report.caseDuplicates.length}`);
  console.log(`  removed, symbol/unit form       ${report.symbolForms.length}`);
  console.log(`\n  wrote ${outPath}`);
}

main();
