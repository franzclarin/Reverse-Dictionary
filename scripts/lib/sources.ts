// Where the raw dictionary downloads live — outside the repo, because they run
// to gigabytes and can always be fetched again from a recorded address.
// Committing them would be storing a cache in version control.
//
// Kept apart from the experiment files too: these are inputs, those are
// results, and they have different reasons to be deleted. Override with
// RD_SOURCE_DIR.
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

/** Fingerprint a file, reading it in pieces. */
// Read in pieces because the file this exists for is far too big to hold whole.
export function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Read a huge text file a line at a time, never holding it all at once. */
// Hand-rolled because the built-in version builds a string for every one of ten
// million lines, even when the caller throws most of them away unread.
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
