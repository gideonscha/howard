import { mintDiscountCode } from "@/lib/shopify";
import { getConfig, offerConfig } from "@/lib/config";
import { db } from "@/lib/supabase";
import { Partner } from "./types";

function codeFor(p: Partner): string {
  const slug = p.business_name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `STAR-${slug}-${rand}`;
}

// Mint the partner's customer-facing discount code (one per partner, unlimited
// redemptions, non-stackable, scoped to the memorial product, min-order gated)
// → ph_referrals, stage='signed', and mark the free 2-set gift due to ship.
export async function runSign(partnerId: string): Promise<{ code: string; trackingUrl: string }> {
  const supa = db();
  const { data: partner, error } = await supa
    .from("ph_partners")
    .select("*")
    .eq("id", partnerId)
    .single();
  if (error || !partner) throw new Error(`sign: partner ${partnerId} not found`);

  const p = partner as Partner;
  const offer = offerConfig(await getConfig());
  const code = codeFor(p);

  const { gid } = await mintDiscountCode(code, `Partner — ${p.business_name}`, {
    percentage: offer.discountPct, // 60
    productGid: offer.memorialProductGid, // scoped to Star in Heaven
    minSubtotal: offer.minOrder, // $79 floor
    combinable: false, // non-stackable
    usageLimit: null, // unlimited redemptions
  });

  const trackingUrl = `${offer.familyCtaUrl}?code=${encodeURIComponent(code)}`;

  await supa.from("ph_referrals").insert({
    partner_id: p.id,
    discount_code: code,
    shopify_discount_gid: gid,
    tracking_url: trackingUrl,
  });

  // Free 2-set partner gift becomes due — surfaces on the Samples page.
  await supa
    .from("ph_partners")
    .update({
      stage: "signed",
      sample_status: "requested",
      updated_at: new Date().toISOString(),
    })
    .eq("id", p.id);

  return { code, trackingUrl };
}
