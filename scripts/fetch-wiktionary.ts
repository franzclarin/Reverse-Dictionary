/**
 * Fetch RD-17's dictionary sources into `RD_SOURCE_DIR`.
 *
 * Two files, both re-downloadable and neither committed:
 *
 *   kaikki-english.jsonl   3.2 GB. The Kaikki.org / `wiktextract` machine-
 *                          readable extraction of English Wiktionary, one JSON
 *                          object per (word, pos, etymology). The candidate
 *                          source for the vocabulary expansion.
 *   oewn.xml.gz            13 MB. Open English WordNet 2024, WN-LMF XML. Read
 *                          only by `probe-oewn-delta.ts` — measured and NOT
 *                          adopted, see METHODS §15.
 *
 * RESUMABLE, because 3.2 GB over a home connection is long enough to be
 * interrupted and `curl -C -` exists for exactly this. A partial file is
 * continued from its current length; a complete one is left alone unless
 * `--force` is passed. Completeness is judged against the server's
 * `content-length`, not against "the file exists" — a truncated 3.1 GB file
 * parses perfectly well and would silently produce a smaller vocabulary.
 *
 *   npx tsx scripts/fetch-wiktionary.ts
 *   npx tsx scripts/fetch-wiktionary.ts --force
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileSha256, sourceDir, sourcePath } from "./lib/sources";
import { LICENCE, SOURCE_URL } from "./lib/wiktionary";

const SOURCES = [
  {
    name: "kaikki-english.jsonl",
    url: SOURCE_URL,
    licence: LICENCE,
    /** Hashing 3.2 GB takes a while and buys little for a file this size. */
    hash: false,
  },
  {
    name: "oewn.xml.gz",
    url: "https://en-word.net/static/english-wordnet-2024.xml.gz",
    licence: "Open English WordNet 2024, CC BY 4.0 — attribution only, no share-alike.",
    hash: true,
  },
];

function remoteSize(url: string): number | null {
  try {
    const head = execFileSync("curl", ["-sIL", "--max-time", "60", url], {
      encoding: "utf8",
      maxBuffer: 1 << 20,
    });
    // Follow-redirect responses stack; the last content-length is the real one.
    const matches = [...head.matchAll(/content-length:\s*(\d+)/gi)];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  } catch {
    return null;
  }
}

function download(url: string, dest: string): void {
  // `-C -` resumes; the server advertises `accept-ranges: bytes`. Retries are
  // curl's rather than ours because a mid-transfer reset should continue from
  // the byte it reached, not restart the file.
  execFileSync(
    "curl",
    ["-sSL", "-C", "-", "--retry", "5", "--retry-delay", "5", "-o", dest, url],
    { stdio: "inherit" }
  );
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  console.log(`\nRD-17 · sources -> ${sourceDir()}\n`);

  const provenance: Record<string, unknown>[] = [];
  for (const source of SOURCES) {
    const dest = sourcePath(source.name);
    const expected = remoteSize(source.url);
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;

    if (!force && expected !== null && have === expected) {
      console.log(`  ${source.name}  already complete (${(have / 1e9).toFixed(2)} GB)`);
    } else {
      if (force && fs.existsSync(dest)) fs.rmSync(dest);
      console.log(
        `  ${source.name}  fetching${expected ? ` ${(expected / 1e9).toFixed(2)} GB` : ""}` +
          `${have && !force ? ` (resuming from ${(have / 1e9).toFixed(2)} GB)` : ""}...`
      );
      download(source.url, dest);
    }

    const size = fs.statSync(dest).size;
    if (expected !== null && size !== expected) {
      // Loud, because the failure mode is silent: a truncated extraction still
      // parses and just yields fewer words, which reads as "Wiktionary has less
      // than we thought" rather than as a broken download.
      console.error(
        `    *** ${source.name} is ${size} bytes, server says ${expected}. INCOMPLETE — ` +
          `re-run; do not build from this file.`
      );
      process.exitCode = 1;
    }
    provenance.push({
      name: source.name,
      url: source.url,
      bytes: size,
      sha256: source.hash ? await fileSha256(dest) : null,
      licence: source.licence,
      fetchedAt: new Date().toISOString(),
    });
  }

  const file = sourcePath("provenance.json");
  fs.writeFileSync(file, JSON.stringify(provenance, null, 2) + "\n", "utf8");
  console.log(`\n  provenance -> ${file}`);
  console.log(
    `\n  LICENCE. ${LICENCE}\n  Any index built from these glosses inherits that obligation — ` +
      `record it wherever the index ships.\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
