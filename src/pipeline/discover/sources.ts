import {
  CreditBudget,
  ExtractedBusiness,
  scrapeBusinesses,
  scrapeLinks,
} from "@/lib/firecrawl";

// Strict variant of the extraction schema for Anthropic structured outputs
// (requires additionalProperties:false + exhaustive required lists).
const CLAUDE_BUSINESS_SCHEMA = {
  type: "object",
  properties: {
    businesses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          business_name: { type: ["string", "null"] },
          city: { type: ["string", "null"] },
          state: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          website: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
        },
        required: ["business_name", "city", "state", "phone", "website", "email"],
        additionalProperties: false,
      },
    },
  },
  required: ["businesses"],
  additionalProperties: false,
};

export interface SourcedPartner extends ExtractedBusiness {
  source: string;
  segment: "memorial" | "vet";
  subtype: string;
  is_chain: boolean;
}

// Some directory sites 403 generic fetchers but allow a plain browser UA;
// try a direct fetch first (free) before spending Firecrawl credits.
async function fetchTextDirect(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// The IAOPCC directory page is a search widget with no crawlable member links.
// Harvest member-profile URLs (/members/?id=NNN) by, in order:
// (1) Firecrawl /map (sitemap + crawl index), (2) direct sitemap fetch,
// (3) directory link-scrape, (4) ph_seed_urls rows (manually seeded backstop).
async function iaopccMemberLinks(budget: CreditBudget): Promise<string[]> {
  const found = new Set<string>();
  const memberUrl = /https?:\/\/(?:www\.)?iaopc\.com\/members\/\?id=\d+/g;
  const isMemberLink = (l: string) => /\/members\/\?id=\d+/.test(l);

  // (1) Firecrawl map — the heavy lifter for hidden directories.
  if (budget.charge(2)) {
    try {
      const { mapSite } = await import("@/lib/firecrawl");
      for (const l of await mapSite("https://www.iaopc.com", "members")) {
        if (isMemberLink(l)) found.add(l);
      }
      console.log(`iaopcc: map yielded ${found.size} member links`);
    } catch (e) {
      console.warn(`iaopcc: map failed: ${(e as Error).message}`);
    }
  }

  // (2) Direct sitemap fetch (free).
  if (found.size === 0) {
    for (const sitemap of [
      "https://www.iaopc.com/sitemap.xml",
      "https://www.iaopc.com/sitemap_index.xml",
    ]) {
      const xml = await fetchTextDirect(sitemap);
      if (!xml) continue;
      for (const m of xml.match(memberUrl) ?? []) found.add(m);
      if (found.size === 0 && xml.includes("<sitemapindex")) {
        for (const child of xml.match(/<loc>([^<]+)<\/loc>/g) ?? []) {
          const url = child.replace(/<\/?loc>/g, "");
          const childXml = await fetchTextDirect(url);
          for (const m of childXml?.match(memberUrl) ?? []) found.add(m);
        }
      }
      if (found.size > 0) break;
    }
  }

  // (3) Directory page link-scrape.
  if (found.size === 0 && budget.charge(1)) {
    const links = await scrapeLinks("https://www.iaopc.com/professionals/professional-members");
    for (const l of links) if (isMemberLink(l)) found.add(l);
  }

  // (4) Seed rows — always unioned in, so manual seeding works regardless.
  const { db } = await import("@/lib/supabase");
  const { data: seeds } = await db()
    .from("ph_seed_urls")
    .select("url")
    .eq("source", "iaopcc");
  for (const s of seeds ?? []) if (s.url) found.add(s.url);

  return [...found];
}

// (2) Association roster — IAOPCC member directory (iaopc.com).
// Membership is itself a quality filter. Server-rendered member pages.
export async function discoverIaopcc(budget: CreditBudget): Promise<SourcedPartner[]> {
  const out: SourcedPartner[] = [];
  const allLinks = await iaopccMemberLinks(budget);

  // Resumable: skip member pages already ingested in earlier runs, and cap
  // per-run volume so the run finishes inside the function time limit.
  const { db } = await import("@/lib/supabase");
  const { data: done } = await db()
    .from("ph_partners")
    .select("source")
    .like("source", "iaopcc:%");
  const doneLinks = new Set((done ?? []).map((r) => r.source.slice("iaopcc:".length)));
  const memberLinks = allLinks.filter((l) => !doneLinks.has(l)).slice(0, 100);
  console.log(
    `iaopcc: ${allLinks.length} member pages found, ${doneLinks.size} already done, processing ${memberLinks.length}`
  );
  const prompt =
    "Extract the pet cemetery / crematory business on this member profile page: business name, city, US state (2-letter), phone, website URL, and contact email if shown. ONLY extract businesses located in the United States — skip UK/Canada/other countries entirely. The website must be the business's own site; never use iaopc.com URLs as the website.";

  const { setProgress } = await import("@/lib/progress");
  let i = 0;
  for (const link of memberLinks) {
    i++;
    if (i % 5 === 1) {
      await setProgress(
        `discover iaopcc: ${i}/${memberLinks.length} member pages (${doneLinks.size} done in earlier runs), ${out.length} businesses so far`
      );
    }
    try {
      let businesses: ExtractedBusiness[] = [];
      // Free path: direct fetch + Claude extraction.
      const html = await fetchTextDirect(link);
      if (html) {
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 12000);
        businesses = await extractBusinessesWithClaude(text, prompt);
      } else {
        // Paid fallback: Firecrawl JSON scrape.
        if (!budget.charge(5)) break;
        businesses = (await scrapeBusinesses(link, prompt)).businesses;
      }
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

async function extractBusinessesWithClaude(
  pageText: string,
  prompt: string
): Promise<ExtractedBusiness[]> {
  const { structured } = await import("@/lib/anthropic");
  const r = await structured<{ businesses: (ExtractedBusiness & Record<string, string | null>)[] }>({
    system:
      "You extract structured business listings from web page text. Only extract businesses actually present in the text; never invent fields.",
    user: `${prompt}\n\nPage text:\n---\n${pageText}\n---`,
    schema: CLAUDE_BUSINESS_SCHEMA,
    maxTokens: 1024,
  });
  // normalize nulls → undefined to match ExtractedBusiness
  return (r.businesses ?? []).map((b) =>
    Object.fromEntries(Object.entries(b).filter(([, v]) => v != null))
  ) as ExtractedBusiness[];
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
  const { setProgress } = await import("@/lib/progress");
  let i = 0;
  for (const brandUrl of external) {
    if (!budget.charge(5)) break;
    i++;
    await setProgress(`discover gateway: ${i}/${external.length} brand sites, ${out.length} locations so far`);
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
  const { setProgress } = await import("@/lib/progress");
  let i = 0;
  for (const page of cityPages) {
    if (!budget.charge(9)) break;
    i++;
    if (i % 5 === 1) {
      await setProgress(`discover lapoflove: ${i}/${cityPages.length} city pages, ${out.length} locations so far`);
    }
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
