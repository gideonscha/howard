import { randomUUID } from "crypto";
import { structured } from "@/lib/anthropic";
import { getConfig, HOWARD_PERSONA, offerBlock, offerConfig } from "@/lib/config";
import { followupDelaysDays, publicBaseUrl, sendingEnabled } from "@/lib/env";
import { db } from "@/lib/supabase";
import { clickToken } from "@/lib/tokens";
import { Outreach, Partner } from "./types";

// The product box shot measurably helps (first interested reply came right
// after it was added to touch 1), so cadence follow-ups carry it — plus the
// wrapped demo link: ~10% of touch-1 recipients click it, and 594 follow-ups
// went out with no clickable action at all. Inserted in CODE above the
// signature — the model never writes the image or link lines.
function withProductBlock(body: string, wrappedUrl?: string): string {
  if (body.includes("product-box.jpg")) return body;
  const img =
    `Here's the set at a glance:\n\n![Magic Portraits — Star in Heaven boxed set](${publicBaseUrl()}/product-box.jpg)` +
    (wrappedUrl ? `\n\nAnd here's exactly what a family would receive — take a look [here](${wrappedUrl}).` : "");
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
      // Pre-generate the id so the follow-up carries its own tracked demo link.
      const fid = randomUUID();
      const wrapped = `${publicBaseUrl()}/c/${clickToken(fid)}`;
      await supa.from("ph_outreach").insert({
        id: fid,
        partner_id: p.id,
        touch_number: touchNumber,
        subject: d.subject,
        body: withProductBlock(d.body, wrapped),
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

  // Stalled-conversation check-in: a partner replied, we answered, and then
  // NOTHING re-engaged them if they went quiet (cadence stops on reply by
  // design — Cia sat silent 12 days). If our last sent message on a replied/
  // interested partner is ≥5 days old with no pending drafts and no prior
  // check-in, draft a gentle nudge — human-gated (needs_attention), because
  // it's a live human conversation.
  const STALL_REASON = "stalled conversation — check-in drafted for review";
  const { data: stalled } = await supa
    .from("ph_partners")
    .select("*, ph_outreach(*)")
    .in("stage", ["replied", "interested"]);
  for (const p of (stalled ?? []) as (Partner & { ph_outreach: Outreach[] })[]) {
    if (p.ph_outreach.some((o) => ["draft", "approved"].includes(o.status))) continue; // something already pending
    if (p.ph_outreach.some((o) => o.attention_reason === STALL_REASON)) continue; // one nudge only
    const lastSent = p.ph_outreach
      .filter((o) => o.status === "sent" && o.sent_at)
      .sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""))[0];
    if (!lastSent?.sent_at) continue;
    const ageDays = (Date.now() - new Date(lastSent.sent_at).getTime()) / 86_400_000;
    if (ageDays < 5) continue;

    const theirReply = p.ph_outreach
      .filter((o) => o.reply_snippet)
      .sort((a, b) => (b.replied_at ?? "").localeCompare(a.replied_at ?? ""))[0]?.reply_snippet;
    try {
      const d = await structured<{ subject: string; body: string }>({
        system: `${HOWARD_PERSONA}\n\nA partner showed real interest, you answered their questions, and they've gone quiet for ~${Math.round(ageDays)} days. Write a SHORT (40-70 words), warm, zero-pressure check-in. Return JSON {subject, body}. Do not re-pitch or restate the whole offer; just make replying easy (e.g. offer to answer anything else, or simply ask if the timing is wrong). No guilt.`,
        user: `Business: ${p.business_name} (${p.city ?? "?"}, ${p.state ?? "?"})
Contact: ${p.contact_name ?? "unknown"}
Their last reply to us:\n${(theirReply ?? "(not captured)").slice(0, 800)}\n\nOur last message to them:\n${(lastSent.body ?? "").slice(0, 1200)}`,
        schema: DRAFT_SCHEMA,
        maxTokens: 512,
      });
      await supa.from("ph_outreach").insert({
        partner_id: p.id,
        touch_number: (lastSent.touch_number ?? 1) + 1,
        subject: d.subject,
        body: d.body,
        status: "draft",
        is_reply_draft: true,
        agentmail_message_id: lastSent.agentmail_message_id,
        agentmail_thread_id: lastSent.agentmail_thread_id,
        needs_attention: true,
        attention_reason: STALL_REASON,
      });
      drafted++;
    } catch (e) {
      console.error(`followup(stalled): failed for ${p.id}: ${(e as Error).message}`);
    }
  }

  return { drafted, gated: false };
}
