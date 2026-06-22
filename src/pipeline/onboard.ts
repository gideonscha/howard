import { randomUUID } from "crypto";
import { getConfig, offerConfig } from "@/lib/config";
import { publicBaseUrl } from "@/lib/env";
import { clickToken } from "@/lib/tokens";
import { db } from "@/lib/supabase";
import { Partner } from "./types";

const TITLES = new Set(["dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms."]);

function firstName(contactName: string | null): string | null {
  if (!contactName) return null;
  const parts = contactName.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length && TITLES.has(parts[i].toLowerCase())) i++;
  return parts[i] ?? null;
}

// Manual "Onboard" action: drafts the onboarding reply into the approval queue
// (human-approve gate — never auto-sends) with both fixed codes, the demo link,
// and a shipping-address ask. Marks the partner's free gift due to ship.
export async function runOnboard(partnerId: string): Promise<{ drafted: boolean }> {
  const supa = db();
  const { data: partner, error } = await supa
    .from("ph_partners")
    .select("*")
    .eq("id", partnerId)
    .single();
  if (error || !partner) throw new Error(`onboard: partner ${partnerId} not found`);
  const p = partner as Partner;

  const offer = offerConfig(await getConfig());
  const base = publicBaseUrl();

  // Thread onto the partner's most recent message so it lands in the same inbox thread.
  const { data: last } = await supa
    .from("ph_outreach")
    .select("*")
    .eq("partner_id", partnerId)
    .not("agentmail_thread_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const id = randomUUID();
  const wrapped = `${base}/c/${clickToken(id)}`;
  const fn = firstName(p.contact_name);
  const greeting = fn ? `Hi ${fn},` : "Hello,";

  const body = [
    greeting,
    `Wonderful — I'm so glad Star in Heaven feels right for ${p.business_name}'s families. Here's everything to get you started.`,
    `Your two free sample sets (a $${offer.giftValue} value, on us): redeem them at ${offer.storeUrl} with code ${offer.giftCode} — it covers both sets in full. If it's easier, just reply with your shipping address and I'll send them out to you directly.`,
    `For your families: share code ${offer.customerCode} — it gives them ${offer.discountPct}% off any memorial order over $${offer.minOrder}, well beyond anything available online. Most partners add it to the keepsake paperwork they already send home, or mention it when a family asks about a memorial.`,
    `Here's exactly what your families would receive: ${wrapped}`,
    `Reply any time with questions — I'm glad to help you get set up.`,
    `Howard / Magic Portraits`,
  ].join("\n\n");

  await supa.from("ph_outreach").insert({
    id,
    partner_id: p.id,
    touch_number: (last?.touch_number ?? 1) + 1,
    subject: last ? `Re: ${last.subject}` : `Getting you set up — Magic Portraits`,
    body,
    status: "draft",
    is_reply_draft: Boolean(last?.agentmail_message_id),
    agentmail_message_id: last?.agentmail_message_id ?? null,
    agentmail_thread_id: last?.agentmail_thread_id ?? null,
    needs_attention: true,
    attention_reason: "ONBOARDING — review & send (both codes + address ask)",
  });

  // Active onboarding + gift due to ship (shows on the Samples to-do rail).
  await supa
    .from("ph_partners")
    .update({
      stage: "negotiating",
      sample_status: "requested",
      updated_at: new Date().toISOString(),
    })
    .eq("id", p.id);

  const { logActivity } = await import("@/lib/activity");
  await logActivity("run", `onboarding drafted for ${p.business_name}`);

  return { drafted: true };
}
