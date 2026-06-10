import { requireEnv } from "./env";

export type EmailStatus = "verified" | "risky" | "invalid" | "unverified";

// ZeroBounce single-email validation. Bounces are the #1 killer of a fresh
// domain's reputation, so send refuses anything that isn't "verified".
export async function verifyEmail(email: string): Promise<EmailStatus> {
  const key = requireEnv("ZEROBOUNCE_API_KEY");
  const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ZeroBounce → ${res.status}`);
  const data = (await res.json()) as { status?: string };
  switch (data.status) {
    case "valid":
      return "verified";
    case "catch-all":
    case "unknown":
    case "do_not_mail":
      return "risky";
    case "invalid":
    case "spamtrap":
    case "abuse":
      return "invalid";
    default:
      return "unverified";
  }
}
