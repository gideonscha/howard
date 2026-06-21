import { ordersByCode } from "@/lib/shopify";
import { getConfig, offerConfig } from "@/lib/config";
import { db } from "@/lib/supabase";

// Roll Shopify orders per referral code into ph_referrals; revenue is net
// (post-discount subtotal), commission = commission_pct of that. Flip
// signed→live on first order so Performance can re-weight scoring.
export async function runAttribute(): Promise<{ synced: number }> {
  const supa = db();
  const offer = offerConfig(await getConfig());
  const { data: referrals, error } = await supa.from("ph_referrals").select("*");
  if (error) throw error;

  let synced = 0;
  for (const r of referrals ?? []) {
    try {
      const { count, revenue } = await ordersByCode(r.discount_code);
      const commission = Math.round(revenue * (offer.commissionPct / 100) * 100) / 100;
      await supa
        .from("ph_referrals")
        .update({
          orders_count: count,
          revenue,
          commission,
          last_synced_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      if (count > 0) {
        await supa
          .from("ph_partners")
          .update({ stage: "live", updated_at: new Date().toISOString() })
          .eq("id", r.partner_id)
          .eq("stage", "signed");
      }
      synced++;
    } catch (e) {
      console.error(`attribute: failed for ${r.discount_code}: ${(e as Error).message}`);
    }
  }
  return { synced };
}
