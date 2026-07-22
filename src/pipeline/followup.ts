import { structured } from "@/lib/anthropic";
import { getConfig, HOWARD_PERSONA, offerBlock, offerConfig } from "@/lib/config";
import { followupDelaysDays, publicBaseUrl, sendingEnabled } from "@/lib/env";
import { db } from "@/lib/supabase";
import { Outreach, Partner } from "./types";

// The product box shot measurably helps (first interested reply came right
// after it was added to touch 1), so cadence follow-ups carry it too. Inserted
// in CODE above the signature — the model never writes the image line.
function withProductImage(body: string): string {
  if (body.includes("product-box.jpg")) return body;
  const img = `Here's the set at a glance:\n\n![Magic Portraits — Star in Heaven boxed set](${publicBaseUrl()}/product-box.jpg)`;
  const signed = body.replace(
    /\n*Howard\s*\/\s*Magic Portraits\s*$/,
    `\n\n${img}\n\nHoward / Magic Portraits`
  );
  return signed.includes("product-box.jpg") ? signed : `${body}\n\n${img}`;
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, body: { type: "string" } },
  required: ["subject", "body"],
  additionalProperties: false,
};

// Touch 2–3 for contacted partners with no reply past the delay, plus the
// post-sample-shipping check-in (~5 days). Drafts only — into the approval
// queue, never sent directly. Gated by SENDING_ENABLED.
export async function runFollowup(): Promise<{ drafted: number; gated: boolean }> {
  if (!sendingEnabled()) {
    console.log("[DRY-RUN] followup: SENDING_ENABLED=false — skipping cadence drafting");
    return { drafted: 0, gated: true };
  }

  const supa = db();
  const delays = followupDelaysDays(); // e.g. [4, 9]
  const offer = offerConfig(await getConfig());
  const followupSystem = `${HOWARD_PERSONA}\n\nYou are writing a brief follow-up to a partner who didn't reply. Return JSON {subject, body}. Keep it short. If you restate the offer, use these EXACT terms, no paraphrasing:\n${offerBlock(offer)}`;
  let drafted = 0;

  const { data: contacted, error } = await supa
    .from("ph_partners")
    .select("*, ph_outreach(*)")
    .eq("stage", "contacted");
  if (error) throw error;

  for (const p of (contacted ?? []) as (Partner & { ph_outreach: Outreach[] })[]) {
    const sentTouches = p.ph_outreach
      .filter((o) => o.status === "sent" && !o.is_reply_draft)
      .sort((a, b) => (a.touch_number ?? 0) - (b.touch_number ?? 0));
    if (sentTouches.length === 0) continue;
    if (p.ph_outreach.some((o) => ["draft", "approved"].includes(o.status))) continue; // already queued
    if (p.ph_outreach.some((o) => o.status === "replied")) continue;

    const last = sentTouches[sentTouches.length - 1];
    const touchNumber = sentTouches.length + 1;
    const maxTouches = delays.length + 1;
    if (touchNumber > maxTouches) continue;

    const delayDays = delays[touchNumber - 2];
    const dueAt = new Date(last.sent_at!);
    dueAt.setDate(dueAt.getDate() + delayDays);
    if (new Date() < dueAt) continue;

    try {
      const d = await structured<{ subject: string; body: string }>({
        system: followupSystem,
        user: `Write follow-up touch #${touchNumber} (no reply to the previous email). Shorter than the first touch (50–80 words), gentle, no guilt. Reference that you wrote before only lightly. Same CTA rules.
Business: ${p.business_name} (${p.city ?? "?"}, ${p.state ?? "?"})
Previous subject: ${last.subject}
Previous body:\n${last.body}`,
        schema: DRAFT_SCHEMA,
        maxTokens: 768,
      });
      await supa.from("ph_outreach").insert({
        partner_id: p.id,
        touch_number: touchNumber,
        subject: d.subject,
        body: withProductImage(d.body),
        status: "draft",
        is_reply_draft: true, // threads onto the original message
        agentmail_message_id: last.agentmail_message_id,
        agentmail_thread_id: last.agentmail_thread_id,
      });
      drafted++;
    } catch (e) {
      console.error(`followup: failed for ${p.id}: ${(e as Error).message}`);
    }
  }

  // Sample follow-up: shipped ~5+ days ago, no follow-up drafted yet.
  const { data: shipped } = await supa
    .from("ph_partners")
    .select("*, ph_outreach(*)")
    .eq("sample_status", "shipped");
  for (const p of (shipped ?? []) as (Partner & { ph_outreach: Outreach[] })[]) {
    if (!p.sample_shipped_at) continue;
    const due = new Date(p.sample_shipped_at);
    due.setDate(due.getDate() + 5);
    if (new Date() < due) continue;
    if (p.ph_outreach.some((o) => o.subject.startsWith("[sample follow-up]") || (o.status === "draft" && o.is_reply_draft))) continue;

    const lastSent = p.ph_outreach.filter((o) => o.status === "sent").sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""))[0];
    try {
      const d = await structured<{ subject: string; body: string }>({
        system: followupSystem,
        user: `The Star in Heaven sample set shipped to this partner ~5 days ago. Write a short, warm check-in (40–70 words): did the set arrive, what did they think. No pressure, no new pitch.
Business: ${p.business_name} (${p.city ?? "?"}, ${p.state ?? "?"})
Contact: ${p.contact_name ?? "unknown"}`,
        schema: DRAFT_SCHEMA,
        maxTokens: 512,
      });
      await supa.from("ph_outreach").insert({
        partner_id: p.id,
        touch_number: (p.ph_outreach.length ?? 0) + 1,
        subject: `[sample follow-up] ${d.subject}`,
        body: d.body,
        status: "draft",
        is_reply_draft: Boolean(lastSent?.agentmail_message_id),
        agentmail_message_id: lastSent?.agentmail_message_id ?? null,
        agentmail_thread_id: lastSent?.agentmail_thread_id ?? null,
      });
      drafted++;
    } catch (e) {
      console.error(`followup(sample): failed for ${p.id}: ${(e as Error).message}`);
    }
  }

  return { drafted, gated: false };
}
