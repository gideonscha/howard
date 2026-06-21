import { db } from "./supabase";

// Offer terms live in ph_config — the single source of truth. The draft offer
// block reads every number from here; nothing is hard-coded in the prompt.
export async function getConfig(): Promise<Record<string, string>> {
  const { data, error } = await db().from("ph_config").select("key,value");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

export interface OfferConfig {
  giftSets: number;
  tilesPerSet: number;
  giftValue: number;
  commissionPct: number;
  discountPct: number;
  minOrder: number;
  memorialProductGid: string;
  familyCtaUrl: string;
}

export function offerConfig(c: Record<string, string>): OfferConfig {
  const n = (k: string, d: number) => {
    const v = Number(c[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    giftSets: n("partner_gift_sets", 2),
    tilesPerSet: n("partner_gift_tiles_per_set", 4),
    giftValue: n("partner_gift_value_usd", 200),
    commissionPct: n("commission_pct", 20),
    discountPct: n("customer_discount_pct", 60),
    minOrder: n("customer_min_order_usd", 79),
    memorialProductGid: c.memorial_product_gid || "gid://shopify/Product/8526505902276",
    familyCtaUrl: c.family_cta_url || "https://magicportraits.ai/memorial",
  };
}

// Shared persona + tone, reused by first-touch drafting, follow-ups, and
// inbound reply handling so Howard sounds like one person everywhere.
export const HOWARD_PERSONA = `You are Howard, partner outreach for Magic Portraits — premium AI pet portraits printed on photo tiles. Our memorial theme "Star in Heaven" honors a pet a family has lost. You write to US pet memorial businesses (crematoriums, pet cemeteries, aftercare providers) and veterinary clinics that do euthanasia, hospice, or aftercare. Tone: warm, brief, human, plain text. Lead with serving THEIR families, never "we want your customers". No marketing-speak, no exclamation points, no "I hope this finds you well".`;

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const word = (n: number) => (n >= 0 && n <= 10 ? WORDS[n] : String(n));

// The fixed, verbatim offer block — identical in every draft, numbers from
// config. Order: partner gift → commission → family discount.
export function offerBlock(o: OfferConfig): string {
  return [
    `Here's the idea, and it costs you nothing:`,
    ``,
    `— ${cap(word(o.giftSets))} free sets of ${word(o.tilesPerSet)} Star in Heaven portraits (around $${o.giftValue}) to keep and display, so you can judge the quality for yourself.`,
    `— A ${o.commissionPct}% commission to you on every order your families place, paid on the amount they pay after their discount.`,
    `— An exclusive ${o.discountPct}% discount for the families you serve — well beyond anything available online — on any order over $${o.minOrder}.`,
  ].join("\n");
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
