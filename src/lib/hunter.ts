// Hunter.io Domain Search — third rung of the email ladder (after site-
// claimed addresses and the contact-page hunt). 1 credit per lookup, so
// callers must gate on "no email found any cheaper way" and mark the
// attempt so a domain is never paid for twice.
interface HunterEmail {
  value: string;
  type: "personal" | "generic";
  confidence: number;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
}

export interface HunterHit {
  email: string;
  contactName: string | null;
}

export async function hunterDomainSearch(website: string): Promise<HunterHit | null> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null; // optional integration — silently absent without a key

  let domain: string;
  try {
    domain = new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(
      /^www\./,
      ""
    );
  } catch {
    return null;
  }

  const res = await fetch(
    `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(key)}`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!res.ok) {
    throw new Error(`Hunter domain-search → ${res.status}`);
  }
  const json = (await res.json()) as { data?: { emails?: HunterEmail[] } };
  const emails = json.data?.emails ?? [];
  if (emails.length === 0) return null;

  // Personal beats generic; within a type, highest confidence wins.
  const best = [...emails].sort(
    (a, b) =>
      (b.type === "personal" ? 1000 : 0) + b.confidence - ((a.type === "personal" ? 1000 : 0) + a.confidence)
  )[0];
  if (!best || best.confidence < 30) return null;

  const name = [best.first_name, best.last_name].filter(Boolean).join(" ");
  return { email: best.value.toLowerCase(), contactName: name || null };
}
