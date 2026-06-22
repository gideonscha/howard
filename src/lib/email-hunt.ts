import { emailDomain, emailDomainAligned, isJunkEmail, PUBLIC_MAIL } from "./contact-guard";

// Direct page fetch with a browser UA — free, fast, works on many small-
// business sites; returns null on any failure so callers can fall back.
export async function fetchTextDirect(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ASSET = /\.(png|jpe?g|gif|svg|webp|css|js)$|@\d+x/i;
const GENERIC_PREFERENCE = ["info", "contact", "hello", "office", "care", "support"];

// Hunt for a contact email: homepage + common contact/about paths, mailto:
// links and plain-text addresses. Only domain-aligned addresses are eligible
// (own-domain or a public mailbox) — a foreign corporate domain found on the
// page is rejected, so one business's site can't hand us another's inbox.
export async function findEmailOnSite(website: string): Promise<string | null> {
  let base: URL;
  try {
    base = new URL(website.startsWith("http") ? website : `https://${website}`);
  } catch {
    return null;
  }
  const siteDomain = base.hostname.replace(/^www\./, "");
  const paths = ["", "/contact", "/contact-us", "/contactus", "/about", "/about-us"];

  const candidates = new Map<string, number>(); // email → score
  for (const path of paths) {
    const html = await fetchTextDirect(new URL(path, base).toString());
    if (!html) continue;
    for (const raw of html.match(EMAIL_RE) ?? []) {
      const email = raw.toLowerCase();
      if (ASSET.test(email) || isJunkEmail(email)) continue;
      // Domain-alignment guard: reject foreign corporate domains outright.
      if (!emailDomainAligned(email, website)) continue;
      const domain = email.split("@")[1];
      let score = 0;
      if (domain === siteDomain) score += 10; // own-domain beats a public mailbox
      else if (PUBLIC_MAIL.has(domain)) score += 2; // gmail etc. — acceptable, lower trust
      const local = email.split("@")[0];
      if (GENERIC_PREFERENCE.includes(local)) score += 3;
      else if (!/^(no-?reply|postmaster|abuse|webmaster|admin)$/.test(local)) score += 5; // personal > generic > role-noise
      candidates.set(email, Math.max(candidates.get(email) ?? 0, score));
    }
    if (candidates.size > 0 && path !== "") break; // contact page hit — good enough
  }

  // Prefer an own-domain address whenever one exists, even if a public-mailbox
  // candidate scored higher on its local part.
  const best = [...candidates.entries()].sort((a, b) => {
    const aOwn = emailDomain(a[0]) === siteDomain ? 1 : 0;
    const bOwn = emailDomain(b[0]) === siteDomain ? 1 : 0;
    if (aOwn !== bOwn) return bOwn - aOwn;
    return b[1] - a[1];
  })[0];
  return best && best[1] > 0 ? best[0] : null;
}
