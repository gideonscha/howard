import {
  CreditBudget,
  ExtractedBusiness,
  scrapeBusinesses,
  scrapeLinks,
} from "@/lib/firecrawl";

export interface SourcedPartner extends ExtractedBusiness {
  source: string;
  segment: "memorial" | "vet";
  subtype: string;
  is_chain: boolean;
}

// (2) Association roster — IAOPCC member directory (iaopc.com).
// Membership is itself a quality filter. Server-rendered member pages.
export async function discoverIaopcc(budget: CreditBudget): Promise<SourcedPartner[]> {
  const out: SourcedPartner[] = [];
  if (!budget.charge(1)) return out;
  const links = await scrapeLinks("https://www.iaopc.com/professionals/professional-members");
  const memberLinks = [...new Set(links.filter((l) => l.includes("/members/")))];
  for (const link of memberLinks) {
    if (!budget.charge(5)) break;
    try {
      const { businesses } = await scrapeBusinesses(
        link,
        "Extract the pet cemetery / crematory business on this member profile page: business name, city, US state (2-letter), phone, website URL, and contact email if shown."
      );
      for (const b of businesses) {
        if (!b.business_name) continue;
        out.push({
          ...b,
          source: `iaopcc:${link}`,
          segment: "memorial",
          subtype: "crematory",
          is_chain: false,
        });
      }
    } catch (e) {
      console.warn(`iaopcc: failed ${link}: ${(e as Error).message}`);
    }
  }
  return out;
}

// (1) Chains & consolidators — Gateway Services brand network.
// Brands page links out to per-brand sites that carry location/contact data.
export async function discoverGateway(budget: CreditBudget): Promise<SourcedPartner[]> {
  const out: SourcedPartner[] = [];
  if (!budget.charge(1)) return out;
  const links = await scrapeLinks("https://www.gatewayservicesinc.com/our-brands-home");
  const external = [
    ...new Set(
      links.filter(
        (l) =>
          l.startsWith("http") &&
          !l.includes("gatewayservicesinc.com") &&
          !l.includes("facebook.") &&
          !l.includes("instagram.") &&
          !l.includes("linkedin.") &&
          !l.includes("twitter.")
      )
    ),
  ];
  for (const brandUrl of external) {
    if (!budget.charge(5)) break;
    try {
      const { businesses } = await scrapeBusinesses(
        brandUrl,
        "This is a pet aftercare / pet cremation brand website. Extract each physical location: business name, city, US state (2-letter), phone, website URL, contact email if shown. Skip Canadian locations."
      );
      for (const b of businesses) {
        if (!b.business_name) continue;
        out.push({
          ...b,
          website: b.website ?? brandUrl,
          source: `gateway:${brandUrl}`,
          segment: "memorial",
          subtype: "aftercare-consolidator",
          is_chain: true,
        });
      }
    } catch (e) {
      console.warn(`gateway: failed ${brandUrl}: ${(e as Error).message}`);
    }
  }
  return out;
}

// (1b) In-home euthanasia network — Lap of Love city pages.
// Edge bot-blocking observed → stealth proxy (≈9 credits per JSON page).
export async function discoverLapOfLove(budget: CreditBudget): Promise<SourcedPartner[]> {
  const out: SourcedPartner[] = [];
  if (!budget.charge(2)) return out;
  const links = await scrapeLinks("https://www.lapoflove.com/find-a-vet", true);
  const cityPages = [
    ...new Set(
      links.filter((l) => /find-a-vet\/[^/]+\/[^/]+/.test(l) && !l.endsWith("find-a-vet"))
    ),
  ];
  for (const page of cityPages) {
    if (!budget.charge(9)) break;
    try {
      const { businesses } = await scrapeBusinesses(
        page,
        "Extract the Lap of Love in-home pet euthanasia service area on this page: use 'Lap of Love – {City}' as business_name, plus city, US state (2-letter), and phone.",
        true
      );
      for (const b of businesses) {
        if (!b.business_name) continue;
        out.push({
          ...b,
          website: page,
          source: `lapoflove:${page}`,
          segment: "memorial",
          subtype: "in-home-euthanasia",
          is_chain: true,
        });
      }
    } catch (e) {
      console.warn(`lapoflove: failed ${page}: ${(e as Error).message}`);
    }
  }
  return out;
}

export const SOURCES: Record<string, (b: CreditBudget) => Promise<SourcedPartner[]>> = {
  iaopcc: discoverIaopcc,
  gateway: discoverGateway,
  lapoflove: discoverLapOfLove,
};
