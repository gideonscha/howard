import { requireEnv } from "./env";

export type EmailStatus = "verified" | "catch_all" | "risky" | "invalid" | "unverified";

// Statuses we'll actually send to. "catch_all" covers ZeroBounce catch-all
// domains (which accept mail) and role-based addresses (info@/office@ — exactly
// our B2B targets). "risky" (unknown / toxic / suppression) and "invalid" are
// held back to protect domain reputation.
export function isSendableStatus(s: string | null | undefined): boolean {
  return s === "verified" || s === "catch_all";
}

// ZeroBounce single-email validation. Bounces are the #1 killer of a fresh
// domain's reputation, so we map conservatively: confirmed-valid and catch-all/
// role addresses are sendable; unknown and toxic/suppression are not.
export async function verifyEmail(email: string): Promise<EmailStatus> {
  const key = requireEnv("ZEROBOUNCE_API_KEY");
  const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ZeroBounce → ${res.status}`);
  const data = (await res.json()) as { status?: string; sub_status?: string; error?: string };
  // ZeroBounce returns HTTP 200 with an { error } body (or simply omits status)
  // when rate-limited / out of credits / on a transient fault. Treat that as a
  // RETRYABLE failure — throw so the caller leaves the row 'unverified' to be
  // re-tried next tick, rather than silently banking a non-result as definitive.
  if (data.error || !data.status) {
    throw new Error(`ZeroBounce no-status response: ${data.error ?? JSON.stringify(data).slice(0, 120)}`);
  }
  const sub = data.sub_status ?? "";
  switch (data.status) {
    case "valid":
      return "verified";
    case "catch-all":
      return "catch_all"; // catch-all domains accept mail — deliverable
    case "do_not_mail":
      // role-based inboxes (info@/office@) are our normal B2B targets; the rest
      // (global_suppression, toxic, possible_trap) we leave held.
      return sub === "role_based" ? "catch_all" : "risky";
    case "unknown":
      return "risky";
    case "invalid":
    case "spamtrap":
    case "abuse":
      return "invalid";
    default:
      // An unrecognised status is unexpected (ZeroBounce's set is fixed) — treat
      // as retryable rather than burning the row to a wrong terminal status.
      throw new Error(`ZeroBounce unexpected status: ${data.status}`);
  }
}
