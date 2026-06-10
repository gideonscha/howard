import { CreditBudget } from "@/lib/firecrawl";
import { db } from "@/lib/supabase";
import { SOURCES, SourcedPartner } from "./sources";

function normalizeDomain(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Source one bounded slice. Dedupes against ph_partners (by website domain and
// by name+city) and ph_suppression before inserting as stage='sourced'.
export async function runDiscover(sourceName?: string): Promise<{
  source: string;
  found: number;
  inserted: number;
  skipped: number;
  creditsSpent: number;
}> {
  const name = sourceName && SOURCES[sourceName] ? sourceName : "iaopcc";
  const budget = new CreditBudget(Number(process.env.FIRECRAWL_RUN_CREDIT_BUDGET ?? 1000));
  const found = await SOURCES[name](budget);

  const supa = db();
  const [{ data: existing }, { data: suppressed }] = await Promise.all([
    supa.from("ph_partners").select("business_name,city,website,email"),
    supa.from("ph_suppression").select("email,domain"),
  ]);

  const seenDomains = new Set(
    (existing ?? []).map((p) => normalizeDomain(p.website ?? undefined)).filter(Boolean)
  );
  const seenNameCity = new Set(
    (existing ?? []).map((p) => `${(p.business_name ?? "").toLowerCase()}|${(p.city ?? "").toLowerCase()}`)
  );
  const suppressedEmails = new Set((suppressed ?? []).map((s) => s.email?.toLowerCase()).filter(Boolean));
  const suppressedDomains = new Set((suppressed ?? []).map((s) => s.domain?.toLowerCase()).filter(Boolean));

  let inserted = 0;
  let skipped = 0;
  for (const p of dedupeBatch(found)) {
    const domain = normalizeDomain(p.website);
    const nameCity = `${(p.business_name ?? "").toLowerCase()}|${(p.city ?? "").toLowerCase()}`;
    if (
      (domain && (seenDomains.has(domain) || suppressedDomains.has(domain))) ||
      seenNameCity.has(nameCity) ||
      (p.email && suppressedEmails.has(p.email.toLowerCase()))
    ) {
      skipped++;
      continue;
    }
    const { error } = await supa.from("ph_partners").insert({
      business_name: p.business_name,
      segment: p.segment,
      subtype: p.subtype,
      city: p.city ?? null,
      state: p.state ?? null,
      website: p.website ?? null,
      email: p.email ?? null,
      phone: p.phone ?? null,
      source: p.source,
      is_chain: p.is_chain,
      stage: "sourced",
    });
    if (error) {
      // unique-index hit (same website twice in a run) counts as a dedupe
      skipped++;
    } else {
      inserted++;
      if (domain) seenDomains.add(domain);
      seenNameCity.add(nameCity);
    }
  }
  return { source: name, found: found.length, inserted, skipped, creditsSpent: budget.spent };
}

function dedupeBatch(items: SourcedPartner[]): SourcedPartner[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const key = `${(p.business_name ?? "").toLowerCase()}|${(p.city ?? "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
