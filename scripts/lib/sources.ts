/**
 * Where RD-17's raw dictionary sources live.
 *
 * NOT in the repo, and not in `EVAL_CELL_DIR` either. The Kaikki English
 * extraction is 3.2 GB and Open English WordNet is another 100 MB unpacked;
 * both are re-downloadable from a URL recorded in their provenance file, so
 * committing them would be storing a cache in git. `EVAL_CELL_DIR` is kept
 * separate because cells are *derived* artifacts with an integrity contract
 * (`inputsSha256`), while these are inputs — different lifecycle, different
 * reasons to delete.
 *
 * Override with RD_SOURCE_DIR.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function sourceDir(): string {
  const dir = process.env.RD_SOURCE_DIR ?? path.join(os.homedir(), "rd_sources");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sourcePath(name: string): string {
  return path.join(sourceDir(), name);
}

/**
 * SHA256 of a file, streamed.
 *
 * Streamed rather than `readFileSync`, because the file this exists for is
 * 3.2 GB and Node's Buffer cap would refuse it outright.
 */
export function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Read a large text file line by line without ever holding it whole.
 *
 * `readline` over a stream would do this too, but it decodes and allocates a
 * string per line for all ~10M lines of the Kaikki file even when the caller
 * rejects 90% of them on a substring test. This yields raw chunks split on
 * newlines and lets the caller decide what to parse.
 */
export async function* readLines(file: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 22 });
  let carry = "";
  for await (const chunk of stream) {
    const text = carry + (chunk as string);
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) if (line) yield line;
  }
  if (carry) yield carry;
}
