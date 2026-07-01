import { promises as dnsp } from "dns";

// Is a recipient domain hosted by a large, tolerant mailbox provider (Google,
// Microsoft, Yahoo/AOL, Apple, or a major enterprise filter)? Those accept a
// well-authenticated young sending domain; small self-hosted servers greylist it
// and time out (transient 4.4.7 bounces). Used to bias warm-up sending toward
// deliverable recipients. Detection is by MX so custom domains on Google
// Workspace / Microsoft 365 count as tolerant — not just free-mail addresses.

const cache = new Map<string, boolean>();

// Free-mail address domains are always major-hosted (skip the MX lookup).
const FREE_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "aol.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
]);

// MX hostnames belonging to tolerant, large-scale mail hosts / filters.
const TOLERANT_MX = [
  /aspmx.*\.google\.com$/i,       // Google Workspace / Gmail
  /(^|\.)googlemail\.com$/i,
  /\.protection\.outlook\.com$/i, // Microsoft 365
  /(^|\.)outlook\.com$/i,
  /(^|\.)hotmail\.com$/i,
  /(^|\.)olc\.protection\.outlook\.com$/i,
  /yahoodns\.net$/i,              // Yahoo / AOL
  /(^|\.)icloud\.com$/i,          // Apple
  /mimecast\.com$/i,              // major enterprise filters (tolerant)
  /pphosted\.com$/i,              // Proofpoint
  /messagelabs\.com$/i,           // Broadcom/Symantec
  /barracudanetworks\.com$/i,
];

export async function isMajorHostedDomain(domain: string | null | undefined): Promise<boolean> {
  if (!domain) return false;
  const d = domain.toLowerCase();
  if (FREE_DOMAINS.has(d)) return true;
  if (cache.has(d)) return cache.get(d) as boolean;
  let result = false;
  try {
    const mx = await dnsp.resolveMx(d);
    const hosts = mx.map((m) => m.exchange.toLowerCase());
    result = hosts.some((h) => TOLERANT_MX.some((re) => re.test(h)));
  } catch {
    // No MX / lookup failure → treat as NOT major-hosted, so warm-up defers it
    // rather than risking a greylisting timeout.
    result = false;
  }
  cache.set(d, result);
  return result;
}
