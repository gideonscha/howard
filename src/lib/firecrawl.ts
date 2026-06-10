import { requireEnv } from "./env";

const BASE = "https://api.firecrawl.dev/v2";

// Crude credit accounting so a discover run stays inside the plan:
// plain scrape ≈ 1 credit/page, JSON-extraction ≈ 5/page, stealth+JSON ≈ 9.
export class CreditBudget {
  spent = 0;
  constructor(public limit: number) {}
  charge(credits: number): boolean {
    if (this.spent + credits > this.limit) return false;
    this.spent += credits;
    return true;
  }
}

async function fc<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv("FIRECRAWL_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firecrawl ${method} ${path} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export interface ExtractedBusiness {
  business_name?: string;
  city?: string;
  state?: string;
  phone?: string;
  website?: string;
  email?: string;
}

export const BUSINESS_SCHEMA = {
  type: "object",
  properties: {
    businesses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          business_name: { type: "string" },
          city: { type: "string" },
          state: { type: "string" },
          phone: { type: "string" },
          website: { type: "string" },
          email: { type: "string" },
        },
      },
    },
  },
};

// Single page → markdown (1 credit). Used by enrich.
export async function scrapeMarkdown(url: string, stealth = false): Promise<string> {
  const r = await fc<{ data?: { markdown?: string } }>("/scrape", {
    url,
    formats: ["markdown"],
    ...(stealth ? { proxy: "stealth" } : {}),
  });
  return r.data?.markdown ?? "";
}

// Single page → structured business list (≈5 credits; ≈9 with stealth).
export async function scrapeBusinesses(
  url: string,
  prompt: string,
  stealth = false
): Promise<{ businesses: ExtractedBusiness[]; links: string[] }> {
  const r = await fc<{
    data?: { json?: { businesses?: ExtractedBusiness[] }; links?: string[] };
  }>("/scrape", {
    url,
    formats: [{ type: "json", prompt, schema: BUSINESS_SCHEMA }, "links"],
    ...(stealth ? { proxy: "stealth" } : {}),
  });
  return {
    businesses: r.data?.json?.businesses ?? [],
    links: r.data?.links ?? [],
  };
}

// Page → links only (1 credit). Used to walk directories before extracting.
export async function scrapeLinks(url: string, stealth = false): Promise<string[]> {
  const r = await fc<{ data?: { links?: string[] } }>("/scrape", {
    url,
    formats: ["links"],
    ...(stealth ? { proxy: "stealth" } : {}),
  });
  return r.data?.links ?? [];
}

// Site → URL inventory via Firecrawl /map (sitemap + crawl index + search).
// The right tool for directories that hide links behind search widgets.
export async function mapSite(url: string, search?: string): Promise<string[]> {
  const r = await fc<{ links?: ({ url: string } | string)[] }>("/map", {
    url,
    ...(search ? { search } : {}),
    limit: 2000,
  });
  return (r.links ?? []).map((l) => (typeof l === "string" ? l : l.url)).filter(Boolean);
}
