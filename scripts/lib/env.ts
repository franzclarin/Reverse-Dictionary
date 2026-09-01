// Reads settings out of .env.local for the scripts, which — unlike the app —
// get none automatically. Written by hand rather than adding a dependency.
// Anything already set in the environment wins.
import fs from "node:fs";
import path from "node:path";

let loaded = false;

export function loadEnv(file = ".env.local"): void {
  if (loaded) return;
  loaded = true;

  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) return;

  for (const rawLine of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
