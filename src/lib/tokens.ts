import { createHmac, timingSafeEqual } from "crypto";

// Stable signing secret for unsubscribe + click tokens. Prefers an explicit
// UNSUBSCRIBE_SECRET; falls back to other already-set stable secrets so tokens
// work without an extra env var. Must be stable across deploys (it is — all
// fallbacks are persistent env vars), and consistent between mint and verify.
function signingSecret(): string {
  const s =
    process.env.UNSUBSCRIBE_SECRET ||
    process.env.CRON_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("No signing secret available (set UNSUBSCRIBE_SECRET)");
  return s;
}

// Unsubscribe tokens: HMAC(email) so the /api/u/[token] link can't be forged
// or enumerated. Token format: base64url(email).base64url(hmac).
function hmac(payload: string): string {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
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
