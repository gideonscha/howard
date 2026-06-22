import { structured } from "@/lib/anthropic";
import { getConfig, HOWARD_PERSONA, offerBlock, offerConfig } from "@/lib/config";
import { db } from "@/lib/supabase";
import { Outreach, Partner } from "./types";

interface ReplyTriage {
  // Intent buckets (LLM-judged, not keyword-matched).
  category:
    | "interested" // any sign of yes / tell-me-more → onboard
    | "question" // a genuine question before deciding
    | "not_interested"
    | "unsubscribe"
    // escalations — flag to Gideon, draft nothing
    | "negotiation_or_terms"
    | "call_request"
    | "complaint"
    | "who_is_howard"
    | "other";
  shipping_address: string | null;
  suggested_reply: string | null;
}

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: [
        "interested",
        "question",
        "not_interested",
        "unsubscribe",
        "negotiation_or_terms",
        "call_request",
        "complaint",
        "who_is_howard",
        "other",
      ],
    },
    shipping_address: { type: ["string", "null"] },
    suggested_reply: { type: ["string", "null"] },
  },
  required: ["category", "shipping_address", "suggested_reply"],
  additionalProperties: false,
};

const ESCALATE = new Set(["negotiation_or_terms", "call_request", "complaint", "who_is_howard", "other"]);

// Intent classifier (LLM-judged, not keyword-matched). Shared by the matched
// reply path (handleReply) and the test-thread path in the inbound webhook.
export async function classifyReplyIntent(opts: {
  businessName: string;
  city?: string | null;
  state?: string | null;
  lastSubject: string;
  replyText: string;
}): Promise<ReplyTriage> {
  const offer = offerConfig(await getConfig());
  try {
    return await structured<ReplyTriage>({
      system: `${HOWARD_PERSONA}

You are classifying the INTENT of an inbound reply from a partner prospect — judge meaning, not keywords. Buckets:
- "interested": ANY sign they want to go ahead or learn more — "yes", "sure", "tell me more", "sounds good", "send them over", "we'd love to". Lean toward this when in doubt between interested and question.
- "question": they're asking something before deciding (how it works, what's the catch, timing) without a clear yes.
- "not_interested": a polite or clear no.
- "unsubscribe": asks to stop being contacted / remove them.
- "negotiation_or_terms": wants different terms, pricing, a contract.
- "call_request": wants a phone call or meeting.
- "complaint": annoyed, reporting spam, upset.
- "who_is_howard": asks who/what Howard is, if this is a bot, etc.
- "other": none of the above.
Write suggested_reply ONLY for "question" (a brief, warm, accurate answer using the offer below) — null for everything else. If a shipping address appears anywhere in the reply, extract it into shipping_address.

The offer (use these EXACT terms if you reference them):
${offerBlock(offer)}`,
      user: `Partner: ${opts.businessName} (${opts.city ?? "?"}, ${opts.state ?? "?"})
Our last email subject: ${opts.lastSubject}
Their reply:
---
${opts.replyText.slice(0, 6000)}
---`,
      schema: TRIAGE_SCHEMA,
      maxTokens: 1024,
    });
  } catch (e) {
    console.error(`inbound triage failed: ${(e as Error).message}`);
    return { category: "other", shipping_address: null, suggested_reply: null };
  }
}

// Handle a reply matched to an outreach thread: classify intent, pause cadence,
// and route. "interested" → stage='interested', pinned for the manual Onboard
// step (no auto-draft). Questions get a drafted reply; escalations get flagged.
export async function handleReply(opts: {
  outreach: Outreach;
  partner: Partner;
  fromEmail: string;
  replyText: string;
  snippet: string;
  inboundMessageId: string;
}): Promise<void> {
  const supa = db();

  // Pause cadence: mark this thread replied, drop pending cadence drafts.
  await supa
    .from("ph_outreach")
    .update({
      status: "replied",
      replied_at: new Date().toISOString(),
      reply_snippet: opts.snippet,
      agentmail_message_id: opts.inboundMessageId, // latest inbound, for threaded replies
      updated_at: new Date().toISOString(),
    })
    .eq("id", opts.outreach.id);
  await supa
    .from("ph_outreach")
    .update({ status: "rejected", attention_reason: "cadence paused — partner replied" })
    .eq("partner_id", opts.partner.id)
    .in("status", ["draft", "approved"]);

  const triage = await classifyReplyIntent({
    businessName: opts.partner.business_name,
    city: opts.partner.city,
    state: opts.partner.state,
    lastSubject: opts.outreach.subject,
    replyText: opts.replyText,
  });

  const { logActivity } = await import("@/lib/activity");
  await logActivity(
    "inbound",
    `reply from ${opts.partner.business_name} — ${triage.category}`,
    { snippet: opts.snippet.slice(0, 200) }
  );

  // Capture any shipping address regardless of bucket (useful at onboarding).
  const addressPatch = triage.shipping_address
    ? { sample_address: triage.shipping_address }
    : {};

  if (triage.category === "unsubscribe" || triage.category === "not_interested") {
    await supa.from("ph_suppression").insert({
      email: opts.fromEmail.toLowerCase(),
      reason: `reply: ${triage.category}`,
    });
    await supa
      .from("ph_partners")
      .update({ stage: "declined", updated_at: new Date().toISOString() })
      .eq("id", opts.partner.id);
    return;
  }

  if (triage.category === "interested") {
    // Hottest signal. Pin for the manual Onboard step — no auto-draft.
    await supa
      .from("ph_partners")
      .update({
        stage: "interested",
        ...addressPatch,
        updated_at: new Date().toISOString(),
      })
      .eq("id", opts.partner.id);
    return;
  }

  if (ESCALATE.has(triage.category)) {
    await supa
      .from("ph_partners")
      .update({ stage: "replied", ...addressPatch, updated_at: new Date().toISOString() })
      .eq("id", opts.partner.id);
    await supa.from("ph_outreach").insert({
      partner_id: opts.partner.id,
      touch_number: (opts.outreach.touch_number ?? 1) + 1,
      subject: `Re: ${opts.outreach.subject}`,
      body: "",
      status: "rejected", // placeholder row — visible in queue, nothing sendable
      is_reply_draft: true,
      agentmail_message_id: opts.inboundMessageId,
      agentmail_thread_id: opts.outreach.agentmail_thread_id,
      needs_attention: true,
      attention_reason: `ESCALATION (${triage.category}) — no draft; loop in Gideon from this thread`,
    });
    return;
  }

  // question → drafted reply into the approval queue
  await supa
    .from("ph_partners")
    .update({ stage: "replied", ...addressPatch, updated_at: new Date().toISOString() })
    .eq("id", opts.partner.id);
  await supa.from("ph_outreach").insert({
    partner_id: opts.partner.id,
    touch_number: (opts.outreach.touch_number ?? 1) + 1,
    subject: `Re: ${opts.outreach.subject}`,
    body: triage.suggested_reply ?? "",
    status: "draft",
    is_reply_draft: true,
    agentmail_message_id: opts.inboundMessageId,
    agentmail_thread_id: opts.outreach.agentmail_thread_id,
    needs_attention: true,
    attention_reason: "question — reply drafted for review",
  });
}
