import { db } from "./supabase";

// Offer terms live in ph_config, populated by Gideon. Until a key exists,
// drafts must speak in structure ("a referral commission"), never numbers.
export async function getConfig(): Promise<Record<string, string>> {
  const { data, error } = await db().from("ph_config").select("key,value");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

export const OFFER_TERM_KEYS = [
  "commission_percent",
  "donation_amount",
  "sample_set_contents",
] as const;

export function configuredTerms(config: Record<string, string>): string[] {
  return OFFER_TERM_KEYS.filter((k) => config[k]?.trim()).map(
    (k) => `${k}: ${config[k]}`
  );
}
