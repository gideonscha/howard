import { createHmac, timingSafeEqual } from "crypto";
import { requireEnv } from "./env";

// Unsubscribe tokens: HMAC(email) so the /api/u/[token] link can't be forged
// or enumerated. Token format: base64url(email).base64url(hmac).
function hmac(payload: string): string {
  return createHmac("sha256", requireEnv("UNSUBSCRIBE_SECRET"))
    .update(payload)
    .digest("base64url");
}

export function unsubscribeToken(email: string): string {
  const e = Buffer.from(email.toLowerCase()).toString("base64url");
  return `${e}.${hmac(e)}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  return verifyToken(token);
}

// Click tokens: HMAC(outreachId) so /c/[token] can't be forged or enumerated.
export function clickToken(outreachId: string): string {
  const e = Buffer.from(outreachId).toString("base64url");
  return `${e}.${hmac(e)}`;
}

export function verifyClickToken(token: string): string | null {
  return verifyToken(token);
}

function verifyToken(token: string): string | null {
  const [e, sig] = token.split(".");
  if (!e || !sig) return null;
  const expected = hmac(e);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(e, "base64url").toString("utf8");
}
