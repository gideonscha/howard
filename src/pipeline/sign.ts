import { mintDiscountCode } from "@/lib/shopify";
import { optionalEnv } from "@/lib/env";
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

// Mint a unique Shopify discount code + tracking URL → ph_referrals, stage='signed'.
export async function runSign(
  partnerId: string,
  percentage = 10
): Promise<{ code: string; trackingUrl: string }> {
  const supa = db();
  const { data: partner, error } = await supa
    .from("ph_partners")
    .select("*")
    .eq("id", partnerId)
    .single();
  if (error || !partner) throw new Error(`sign: partner ${partnerId} not found`);

  const p = partner as Partner;
  const code = codeFor(p);
  const { gid } = await mintDiscountCode(code, `Partner referral — ${p.business_name}`, percentage);

  const storeBase = optionalEnv("PUBLIC_STORE_URL", "https://store.magicportraits.ai").replace(/\/$/, "");
  const trackingUrl = `${storeBase}/discount/${encodeURIComponent(code)}?utm_source=partner&utm_medium=referral&utm_campaign=${encodeURIComponent(p.id)}`;

  await supa.from("ph_referrals").insert({
    partner_id: p.id,
    discount_code: code,
    shopify_discount_gid: gid,
    tracking_url: trackingUrl,
  });
  await supa
    .from("ph_partners")
    .update({ stage: "signed", updated_at: new Date().toISOString() })
    .eq("id", p.id);

  return { code, trackingUrl };
}
