/**
 * Add fingerprints to experiment files built before they were recorded.
 *
 * A half-finished parallel rebuild once left overlapping output. The surviving
 * files were argued to be correct from timestamps and speeds — sound reasoning,
 * but inference, and every number downstream depends on those files being what
 * they claim. A fingerprint turns the argument into a record.
 *
 * What it does and does not prove: the fingerprint of the inputs is recomputed
 * from the current record, so a file that matches is provably built from what
 * that record describes — a real check, running now. The fingerprint of the
 * output only pins the file from this moment onward; it cannot prove the file
 * was never disturbed before. Worth stating rather than glossing over.
 *
 * A file whose fingerprint disagrees is not written to. It is reported, because
 * that is the finding.
 *
 *   npx tsx scripts/backfill-cell-hashes.ts            # report only
 *   npx tsx scripts/backfill-cell-hashes.ts --write
 */
import fs from "node:fs";
import path from "node:path";
import { cellDir, type CellMeta } from "./lib/localIndex";
import { cellInputTexts, inputsSha256, bytesSha256 } from "./lib/cellText";
import type { PoolManifest } from "./build-eval-pool";

const MANIFEST = path.resolve(process.cwd(), "eval/data/pool-manifest.json");

function main(): void {
  const write = process.argv.includes("--write");
  const dir = cellDir();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as PoolManifest;

  const expected = new Map<string, string>();
  for (const variant of ["lemma", "gloss", "gloss_examples", "lemma_gloss"]) {
    const rep = variant === "lemma" ? "lemma" : "gloss";
    expected.set(variant, inputsSha256(cellInputTexts(rep as "lemma" | "gloss", variant, manifest)));
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`cell dir: ${dir}`);
  console.log(`manifest: ${manifest.scale} scale, ${manifest.poolWords.toLocaleString()} words\n`);
  console.log(`  ${write ? "WRITING" : "DRY RUN — pass --write to persist"}\n`);

  for (const file of files) {
    const jsonPath = path.join(dir, file);
    const meta = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as CellMeta;
    const vecPath = path.join(dir, `${meta.cell}.vec`);
    if (!fs.existsSync(vecPath)) {
      console.log(`  ${meta.cell.padEnd(24)} no .vec — skipped`);
      continue;
    }

    const want = expected.get(meta.variant);
    const vecHash = bytesSha256(fs.readFileSync(vecPath));

        // A file built from a different pool cannot match the current record. That
        // is expected, and is reported as such rather than as corruption.
    const rowsFromThisPool =
      meta.rows ===
      (meta.representation === "lemma" ? manifest.words.length : manifest.glosses.length);

    let verdict: string;
    let inputsHash: string | undefined;

    if (!rowsFromThisPool) {
      verdict = "different pool — input hash not applicable";
    } else if (want === undefined) {
      verdict = `unknown variant "${meta.variant}"`;
    } else {
      inputsHash = want;
      verdict =
        meta.inputsSha256 === undefined
          ? "backfilled"
          : meta.inputsSha256 === want
            ? "already recorded, MATCHES"
            : "*** MISMATCH — NOT WRITTEN ***";
    }

    const mismatch = verdict.startsWith("***");
    console.log(
      `  ${meta.cell.padEnd(24)} ${String(meta.rows).padStart(7)} rows  ` +
        `${(meta.scale ?? "sampled").padEnd(8)} ${verdict}`
    );
    if (inputsHash) console.log(`      inputs  ${inputsHash.slice(0, 32)}…`);
    console.log(`      vectors ${vecHash.slice(0, 32)}…`);

    if (write && !mismatch) {
      const updated: CellMeta = {
        ...meta,
        ...(inputsHash ? { inputsSha256: inputsHash } : {}),
        vectorsSha256: vecHash,
      };
      fs.writeFileSync(jsonPath, JSON.stringify(updated), "utf8");
    }
  }

  console.log(
    `\n  Note: the input hash is a real check — it is recomputed from the manifest and\n` +
      `  compared. The vector hash pins the bytes from now on; it cannot prove the past.\n`
  );
}

main();
