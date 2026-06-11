import { structured } from "@/lib/anthropic";
import { configuredTerms, getConfig } from "@/lib/config";
import { db } from "@/lib/supabase";
import { howardSystemPrompt } from "./draft";
import { Outreach, Partner } from "./types";

interface ReplyTriage {
  category:
    | "simple_info_request"
    | "sample_request"
    | "unsubscribe_request"
    | "negotiation_or_terms"
    | "call_request"
    | "complaint"
    | "who_is_howard"
    | "not_interested"
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
        "simple_info_request",
        "sample_request",
        "unsubscribe_request",
        "negotiation_or_terms",
        "call_request",
        "complaint",
        "who_is_howard",
        "not_interested",
        "other",
      ],
    },
    shipping_address: { type: ["string", "null"] },
    suggested_reply: { type: ["string", "null"] },
  },
  required: ["category", "shipping_address", "suggested_reply"],
  additionalProperties: false,
};

// Escalation-only categories: flag prominently, draft nothing.
const ESCALATE = new Set(["negotiation_or_terms", "call_request", "complaint", "who_is_howard", "other"]);

// Handle a reply matched to an outreach thread: triage, update stages, pause
// cadence, and either draft a reply (simple cases → approval queue) or escalate.
export async function handleReply(opts: {
  outreach: Outreach;
  partner: Partner;
  fromEmail: string;
  replyText: string;
  snippet: string;
  inboundMessageId: string;
}): Promise<void> {
  const supa = db();
  const config = await getConfig();
  const terms = configuredTerms(config);

  // Pause the cadence: mark this thread replied, drop pending cadence drafts.
  await supa
    .from("ph_outreach")
    .update({
      status: "replied",
      replied_at: new Date().toISOString(),
      reply_snippet: opts.snippet,
      updated_at: new Date().toISOString(),
    })
    .eq("id", opts.outreach.id);
  await supa
    .from("ph_outreach")
    .update({ status: "rejected", attention_reason: "cadence paused — partner replied" })
    .eq("partner_id", opts.partner.id)
    .in("status", ["draft", "approved"]);
  await supa
    .from("ph_partners")
    .update({ stage: "replied", updated_at: new Date().toISOString() })
    .eq("id", opts.partner.id);

  let triage: ReplyTriage;
  try {
    triage = await structured<ReplyTriage>({
      system: `${howardSystemPrompt(terms)}

You are triaging an inbound reply from a partner prospect. Categorize it. Only write suggested_reply for simple_info_request and sample_request — for everything else set it to null (a human will handle it). Howard never claims to be human; if asked who/what Howard is, that is category who_is_howard and gets escalated ("looping in Gideon"). If they ask to receive the sample set, capture any shipping address present.`,
      user: `Partner: ${opts.partner.business_name} (${opts.partner.city ?? "?"}, ${opts.partner.state ?? "?"})
Our last email subject: ${opts.outreach.subject}
Their reply:
---
${opts.replyText.slice(0, 6000)}
---`,
      schema: TRIAGE_SCHEMA,
      maxTokens: 1024,
    });
  } catch (e) {
    console.error(`inbound triage failed: ${(e as Error).message}`);
    triage = { category: "other", shipping_address: null, suggested_reply: null };
  }

  const { logActivity } = await import("@/lib/activity");
  await logActivity(
    "inbound",
    `reply from ${opts.partner.business_name} — triaged as ${triage.category}`,
    { snippet: opts.snippet.slice(0, 200) }
  );

  if (triage.category === "unsubscribe_request" || triage.category === "not_interested") {
    await supa.from("ph_suppression").insert({
      email: opts.fromEmail.toLowerCase(),
      domain: null,
      reason: `reply: ${triage.category}`,
    });
    await supa
      .from("ph_partners")
      .update({ stage: "declined", updated_at: new Date().toISOString() })
      .eq("id", opts.partner.id);
    return;
  }

  if (triage.category === "sample_request") {
    // Hottest signal. Capture address, draft confirmation, flag top of queue.
    await supa
      .from("ph_partners")
      .update({
        sample_status: "requested",
        sample_address: triage.shipping_address ?? opts.partner.sample_address,
        stage: "negotiating",
        updated_at: new Date().toISOString(),
      })
      .eq("id", opts.partner.id);
    await supa.from("ph_outreach").insert({
      partner_id: opts.partner.id,
      touch_number: (opts.outreach.touch_number ?? 1) + 1,
      subject: `Re: ${opts.outreach.subject}`,
      body:
        triage.suggested_reply ??
        "Wonderful — I'll get a Star in Heaven sample set on its way to you. Could you confirm the best shipping address?",
      status: "draft",
      is_reply_draft: true,
      agentmail_message_id: opts.inboundMessageId,
      agentmail_thread_id: opts.outreach.agentmail_thread_id,
      needs_attention: true,
      attention_reason: triage.shipping_address
        ? `SAMPLE REQUEST — address captured: ${triage.shipping_address}`
        : "SAMPLE REQUEST — no address yet, confirmation draft asks for it",
    });
    return;
  }

  if (ESCALATE.has(triage.category)) {
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

  // simple_info_request → drafted reply into the approval queue
  await supa.from("ph_outreach").insert({
    partner_id: opts.partner.id,
    touch_number: (opts.outreach.touch_number ?? 1) + 1,
    subject: `Re: ${opts.outreach.subject}`,
    body: triage.suggested_reply ?? "",
    status: "draft",
    is_reply_draft: true,
    agentmail_message_id: opts.inboundMessageId,
    agentmail_thread_id: opts.outreach.agentmail_thread_id,
    needs_attention: false,
    attention_reason: "reply draft — info request",
  });
}
