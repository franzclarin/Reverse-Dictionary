import crypto from "crypto";

const SECRET =
  process.env.GAME_TOKEN_SECRET ?? "rd-games-dev-secret-change-in-prod";

export function signToken(payload: Record<string, unknown>): string {
  const data = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + 3_600_000 })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(
  token: string
): T | null {
  try {
    const dot = token.lastIndexOf(".");
    if (dot === -1) return null;
    const data = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(data)
      .digest("base64url");
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      return null;
    const payload = JSON.parse(
      Buffer.from(data, "base64url").toString()
    ) as T & { exp: number };
    if (Date.now() > payload.exp) return null;
    return payload as T;
  } catch {
    return null;
  }
}
