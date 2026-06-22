// Contact-accuracy guards — shared by the email hunter and the enrich step so
// a scraped/extracted address can never be attached to the wrong business.
//
// The core rule: an email is "domain-aligned" to a business only if its domain
// matches the business's own website domain, OR it's a public mailbox provider
// (gmail/yahoo/…) which by definition can't be *another company's* corporate
// inbox. A non-public domain that differs from the site's own domain is the
// cross-contamination signal (e.g. a fondmemoriespcc.com address sitting on
// houstonpetcremationservices.com) and is rejected.

export const PUBLIC_MAIL = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com",
  "icloud.com", "me.com", "msn.com", "live.com", "comcast.net",
  "sbcglobal.net", "att.net", "verizon.net", "cox.net", "ymail.com",
  "protonmail.com", "proton.me", "gmx.com",
]);

// Whole-address placeholders that template kits, theme demos and web-font
// license headers leave embedded in page source — they verify as "real"
// mailboxes but belong to no prospect.
export const JUNK_EMAILS = new Set([
  "user@domain.com",
  "mymail@mailservice.com",
  "filler@godaddy.com",
  "email@example.com",
  "info@example.com",
  "name@email.com",
  "youremail@domain.com",
  "impallari@gmail.com", // font designer (Pablo Impallari) — appears in webfont headers
]);

// Domains that are never a pet-business contact: placeholders + the font
// foundries whose addresses ride along in CSS/@font-face license comments.
export const JUNK_DOMAINS = new Set([
  "domain.com", "example.com", "example.org", "email.com", "mailservice.com",
  "godaddy.com", "sentry.io", "wixpress.com", "indiantypefoundry.com",
  "typemade.mx", "fontfabric.com", "latinotype.com", "sentry-next.wixpress.com",
]);

export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function emailDomain(email: string): string | null {
  const d = email.toLowerCase().split("@")[1];
  return d ? d.replace(/^www\./, "") : null;
}

export function isJunkEmail(email: string): boolean {
  const e = email.toLowerCase().trim();
  if (JUNK_EMAILS.has(e)) return true;
  const d = emailDomain(e);
  if (!d) return true;
  if (JUNK_DOMAINS.has(d)) return true;
  // bare numeric / obviously templated local parts
  if (/^(your|sample|test|demo|example)(name|email|mail)?$/.test(e.split("@")[0])) return true;
  return false;
}

// Is `email` an acceptable contact for a business whose site is `website`?
// own-domain match → yes; public provider → yes (can't be another company's
// corporate inbox); any other non-public domain ≠ the site domain → no.
export function emailDomainAligned(email: string, website: string | null | undefined): boolean {
  if (isJunkEmail(email)) return false;
  const ed = emailDomain(email);
  if (!ed) return false;
  if (PUBLIC_MAIL.has(ed)) return true;
  const wd = domainOf(website);
  if (!wd) return false; // non-public domain but no site to corroborate → don't trust
  return ed === wd;
}
