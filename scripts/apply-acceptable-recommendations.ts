/**
 * Write approved recommendations into the `acceptable` column of the draft TSV.
 *
 * This is the ONLY script in the repo that edits `eval/sets/v1-draft.tsv`, and
 * it runs only on an explicit decision. Defaults to a dry run; `--apply` is
 * required to touch the file, and a timestamped backup is written first.
 *
 * WHAT IT PRESERVES. Comment lines, the header, column order, and every other
 * field are passed through untouched. Rows shorter than the header are padded
 * rather than reshaped. The `acceptable` column is MERGED, never overwritten:
 * anything already there is kept and comes first, and new entries are appended
 * only if not already present (case-insensitively). Running it twice is a no-op.
 *
 * By default only `accept` rows are applied. `unsure` rows are deliberately left
 * out: lenient R@1 is the metric the pre-committed decision rule resolves on
 * (METHODS section 9a), so an over-accepted entry silently inflates the number
 * that decides the experiment. Under-accepting costs a manual override instead.
 *
 *   npx tsx scripts/apply-acceptable-recommendations.ts
 *   npx tsx scripts/apply-acceptable-recommendations.ts --apply
 *   npx tsx scripts/apply-acceptable-recommendations.ts --apply --include unsure
 */
import fs from "node:fs";
import path from "node:path";

const DRAFT = path.resolve(process.cwd(), "eval/sets/v1-draft.tsv");
const RECS = path.resolve(process.cwd(), "eval/audit/acceptable-recommendations.tsv");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const isComment = (line: string) => line.startsWith("#") || line.startsWith('"#');

function main(): void {
  const apply = process.argv.includes("--apply");
  const include = new Set(["accept", ...(arg("--include") ? [arg("--include")!] : [])]);

  // ------------------------------------------------ read recommendations
  const recs = new Map<string, string[]>();
  let considered = 0;
  for (const line of fs.readFileSync(RECS, "utf8").split(/\r?\n/)) {
    if (!line.trim() || isComment(line)) continue;
    const [target, , candidate, rec] = line.split("\t");
    if (!target || target === "target" || !candidate) continue;
    if (!include.has(rec)) continue;
    considered++;
    if (!recs.has(target)) recs.set(target, []);
    recs.get(target)!.push(candidate);
  }

  // --------------------------------------------------------- read draft
  const raw = fs.readFileSync(DRAFT, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isComment(lines[i]) && lines[i].trim()) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error("no header row found in the draft");

  const header = lines[headerIdx].split("\t").map((h) => h.trim());
  const targetCol = header.indexOf("target");
  const acceptCol = header.indexOf("acceptable");
  if (targetCol === -1 || acceptCol === -1) {
    throw new Error(`draft is missing target/acceptable columns: ${header.join(", ")}`);
  }

  let rowsChanged = 0;
  let entriesAdded = 0;
  let entriesKept = 0;
  const unmatched = new Set(recs.keys());
  const samples: string[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || isComment(line)) continue;

    const cells = line.split("\t");
    while (cells.length < header.length) cells.push("");

    const target = (cells[targetCol] ?? "").trim();
    const proposed = recs.get(target);
    if (!proposed) continue;
    unmatched.delete(target);

    const existing = (cells[acceptCol] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    entriesKept += existing.length;

    const seen = new Set(existing.map((s) => s.toLowerCase()));
    const added: string[] = [];
    for (const c of proposed) {
      if (seen.has(c.toLowerCase())) continue;
      seen.add(c.toLowerCase());
      added.push(c);
    }
    if (!added.length) continue;

    cells[acceptCol] = [...existing, ...added].join(", ");
    lines[i] = cells.join("\t");
    rowsChanged++;
    entriesAdded += added.length;
    if (samples.length < 6) samples.push(`  ${target}  ->  ${cells[acceptCol]}`);
  }

  console.log(`Recommendations applied: ${[...include].join(", ")}`);
  console.log(`  candidates considered  ${considered}`);
  console.log(`  rows changed           ${rowsChanged}`);
  console.log(`  entries added          ${entriesAdded}`);
  console.log(`  existing entries kept  ${entriesKept}`);
  if (unmatched.size) {
    console.log(`  targets not found in the draft: ${[...unmatched].join(", ")}`);
  }
  console.log("");
  for (const s of samples) console.log(s);

  if (!apply) {
    console.log(`\n  DRY RUN — nothing written. Pass --apply to write ${path.relative(process.cwd(), DRAFT)}.`);
    return;
  }

  const backup = `${DRAFT}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(DRAFT, backup);
  fs.writeFileSync(DRAFT, lines.join(eol), "utf8");
  console.log(`\n  backup  ${path.relative(process.cwd(), backup)}`);
  console.log(`  wrote   ${path.relative(process.cwd(), DRAFT)}`);
}

main();
