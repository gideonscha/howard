import { db } from "@/lib/supabase";
import { Partner } from "./types";

// fit_score ∈ [0,100]: segment intent + reachability + warmth + chain value.
export function computeFitScore(p: Partner): number {
  let score = 0;

  // Segment intent: crematorium > vet-with-aftercare > general vet
  if (p.segment === "memorial") {
    score += p.subtype === "crematory" ? 35 : 30;
  } else {
    score += p.offers_aftercare ? 25 : 10;
  }

  // Reachability: verified direct email > risky email > form/phone only
  if (p.email && p.email_status === "verified") score += 25;
  else if (p.email && p.email_status === "risky") score += 12;
  else if (p.website) score += 6;
  else if (p.phone) score += 3;

  // Warmth: proven memorial retailer, established/high-review
  if (p.sells_memorial_products) score += 15;
  if ((p.reviews_count ?? 0) >= 50) score += 5;
  if ((p.rating ?? 0) >= 4.5) score += 5;

  // Chain value: one signature → many locations
  if (p.is_chain) score += 15;

  return Math.min(100, score);
}

export async function runScore(): Promise<{ scored: number }> {
  const supa = db();
  const { data: partners, error } = await supa
    .from("ph_partners")
    .select("*")
    .in("stage", ["qualified", "queued"]);
  if (error) throw error;

  for (const p of (partners ?? []) as Partner[]) {
    await supa
      .from("ph_partners")
      .update({
        fit_score: computeFitScore(p),
        stage: "queued",
        updated_at: new Date().toISOString(),
      })
      .eq("id", p.id);
  }
  return { scored: partners?.length ?? 0 };
}
