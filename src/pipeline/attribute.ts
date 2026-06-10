import { ordersByCode } from "@/lib/shopify";
import { db } from "@/lib/supabase";

// Roll Shopify orders per referral code into ph_referrals; flip signed→live
// on first order so Performance can re-weight scoring by segment/region.
export async function runAttribute(): Promise<{ synced: number }> {
  const supa = db();
  const { data: referrals, error } = await supa.from("ph_referrals").select("*");
  if (error) throw error;

  let synced = 0;
  for (const r of referrals ?? []) {
    try {
      const { count, revenue } = await ordersByCode(r.discount_code);
      await supa
        .from("ph_referrals")
        .update({
          orders_count: count,
          revenue,
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
