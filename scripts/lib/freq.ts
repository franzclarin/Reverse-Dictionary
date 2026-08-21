/**
 * Frequency bands for eval stratification.
 *
 * Zipf scale: log10(occurrences per billion words). ~7 = "the", ~5 = an
 * everyday word, ~3 = fairly rare, ~1 = very rare. Lemmas absent from the
 * frequency source are treated as `rare`.
 */
import fs from "node:fs";
import path from "node:path";

export type FreqBand = "very_common" | "common" | "mid" | "uncommon" | "rare";

export const FREQ_BANDS: FreqBand[] = [
  "very_common",
  "common",
  "mid",
  "uncommon",
  "rare",
];

export function bandOf(zipf: number | undefined | null): FreqBand {
  if (zipf === undefined || zipf === null || Number.isNaN(zipf)) return "rare";
  if (zipf >= 5) return "very_common";
  if (zipf >= 4) return "common";
  if (zipf >= 3) return "mid";
  if (zipf >= 2) return "uncommon";
  return "rare";
}

export const DEFAULT_ZIPF_PATH = "eval/data/zipf-en.tsv";

export function loadZipf(file = DEFAULT_ZIPF_PATH): Map<string, number> {
  const full = path.resolve(process.cwd(), file);
  const map = new Map<string, number>();
  if (!fs.existsSync(full)) return map;

  for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    map.set(line.slice(0, tab), Number(line.slice(tab + 1)));
  }
  return map;
}
