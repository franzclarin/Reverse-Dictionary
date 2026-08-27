/**
 * Error introspection helpers.
 *
 * Node/undici throws a bare `TypeError: fetch failed` for every network
 * problem and hides the real reason on `error.cause` (an AggregateError or a
 * SystemError carrying `code`/`errno`/`hostname`). Logging `err.message`
 * alone therefore tells us nothing. Everything here exists to dig that out.
 */

/** Which outbound dependency blew up. Drives the user-facing message. */
export type Subsystem = "model" | "database" | "unknown";

export class SubsystemError extends Error {
  readonly subsystem: Subsystem;

  constructor(subsystem: Subsystem, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SubsystemError";
    this.subsystem = subsystem;
  }
}

export type ErrorShape = {
  name: string;
  message: string;
  /** e.g. ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT */
  code?: string;
  errno?: number | string;
  hostname?: string;
  /** "TypeError: fetch failed <- Error: getaddrinfo ENOTFOUND ..." */
  causeChain: string;
  stack?: string;
};

type MaybeSystemError = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  errno?: unknown;
  hostname?: unknown;
  host?: unknown;
  cause?: unknown;
  errors?: unknown;
  stack?: unknown;
};

function asRecord(value: unknown): MaybeSystemError | undefined {
  return typeof value === "object" && value !== null ? (value as MaybeSystemError) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Flatten an error and its `cause` chain (plus any AggregateError `errors`,
 * which is how undici reports "tried every resolved address and all failed").
 * Bounded so a self-referential cause can't spin forever.
 */
function flatten(err: unknown, out: MaybeSystemError[] = [], depth = 0): MaybeSystemError[] {
  if (depth > 6) return out;
  const rec = asRecord(err);
  if (!rec || out.includes(rec)) return out;
  out.push(rec);

  if (rec.cause) flatten(rec.cause, out, depth + 1);
  if (Array.isArray(rec.errors)) {
    for (const nested of rec.errors) flatten(nested, out, depth + 1);
  }
  return out;
}

export function describeError(err: unknown): ErrorShape {
  const chain = flatten(err);
  const top = chain[0];

  // The top-level `fetch failed` carries no code; the useful fields live on a
  // deeper link, so take the first occurrence of each anywhere in the chain.
  const code = chain.map((e) => str(e.code)).find(Boolean);
  const hostname = chain.map((e) => str(e.hostname) ?? str(e.host)).find(Boolean);
  const errnoLink = chain.find((e) => typeof e.errno === "number" || typeof e.errno === "string");

  return {
    name: str(top?.name) ?? (err instanceof Error ? err.name : typeof err),
    message: str(top?.message) ?? String(err),
    code,
    hostname,
    errno: errnoLink?.errno as number | string | undefined,
    causeChain: chain
      .map((e) => `${str(e.name) ?? "Error"}: ${str(e.message) ?? "(no message)"}`)
      .join(" <- "),
    stack: str(top?.stack),
  };
}

/** True when the failure is a network problem rather than a logic bug. */
export function isNetworkError(shape: ErrorShape): boolean {
  if (shape.message === "fetch failed") return true;
  return Boolean(
    shape.code &&
      /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/.test(
        shape.code
      )
  );
}

/** Compact one-line form for console.error, so Vercel logs stay greppable. */
export function formatErrorShape(shape: ErrorShape): string {
  const parts = [
    `name=${shape.name}`,
    `message=${JSON.stringify(shape.message)}`,
    shape.code ? `cause.code=${shape.code}` : undefined,
    shape.errno !== undefined ? `cause.errno=${shape.errno}` : undefined,
    shape.hostname ? `cause.hostname=${shape.hostname}` : undefined,
    `chain=${JSON.stringify(shape.causeChain)}`,
  ].filter(Boolean);
  return parts.join(" ");
}
