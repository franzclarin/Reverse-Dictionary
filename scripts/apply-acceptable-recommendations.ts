/**
 * Write approved alternative answers into the draft question file.
 *
 * The only script that edits that file, and it runs only on an explicit
 * decision. It reports by default; writing needs a flag, and a timestamped
 * backup is taken first.
 *
 * Comments, the header and every other column pass through untouched. The
 * alternatives column is merged, never overwritten: what is already there is
 * kept and comes first, and new entries are added only if not already present.
 * Running it twice changes nothing.
 *
 * Only clearly accepted rows are applied. Uncertain ones are deliberately left
 * out: decisions are made on the forgiving score, so an over-accepted entry
 * silently inflates the very number that decides the experiment. Being too
 * cautious costs a manual override instead.
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
