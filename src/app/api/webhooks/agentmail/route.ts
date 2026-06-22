import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { db } from "@/lib/supabase";
import { handleReply } from "@/pipeline/inbound";
import { Outreach, Partner } from "@/pipeline/types";

export const maxDuration = 60;

interface AgentMailEvent {
  event_type: string;
  message?: {
    inbox_id: string;
    thread_id: string;
    message_id: string;
    from: string;
    subject?: string;
    preview?: string;
    text?: string;
    extracted_text?: string;
    in_reply_to?: string;
  };
  bounce?: { thread_id?: string; message_id?: string; recipients?: string[] };
  complaint?: { thread_id?: string; message_id?: string; recipients?: string[] };
}

function parseAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
  if (!secret) return new NextResponse("Webhook secret not configured", { status: 503 });

  const payload = await req.text();
  let event: AgentMailEvent;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(payload, {
      "svix-id": req.headers.get("svix-id") ?? "",
      "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
      "svix-signature": req.headers.get("svix-signature") ?? "",
    }) as AgentMailEvent;
  } catch {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const supa = db();

  // Bounces and complaints → suppression + outreach status; the early warning
  // for domain reputation on the Health view.
  if (event.event_type === "message.bounced" || event.event_type === "message.complained") {
    const info = event.bounce ?? event.complaint;
    const { logActivity } = await import("@/lib/activity");
    await logActivity(
      "suppression",
      `${event.event_type} — ${(info?.recipients ?? []).join(", ") || "unknown recipient"}`
    );
    for (const recipient of info?.recipients ?? []) {
      await supa.from("ph_suppression").insert({
        email: recipient.toLowerCase(),
        reason: event.event_type,
      });
      await supa
        .from("ph_partners")
        .update({ email_status: "invalid", updated_at: new Date().toISOString() })
        .ilike("email", recipient);
    }
    if (info?.thread_id) {
      await supa
        .from("ph_outreach")
        .update({ status: "bounced", updated_at: new Date().toISOString() })
        .eq("agentmail_thread_id", info.thread_id)
        .eq("status", "sent");
    }
    return NextResponse.json({ ok: true });
  }

  if (event.event_type !== "message.received" || !event.message) {
    return NextResponse.json({ ok: true, ignored: event.event_type });
  }

  const msg = event.message;
  const fromEmail = parseAddress(msg.from);

  // Match the thread to our outreach.
  const { data: outreach } = await supa
    .from("ph_outreach")
    .select("*, ph_partners(*)")
    .eq("agentmail_thread_id", msg.thread_id)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!outreach) {
    // Test-send path: replies to a test thread (recorded in ph_config by
    // /api/run/test-send) are triaged + logged to the Activity feed to prove
    // the inbound round-trip — WITHOUT any partner/outreach writes.
    const { data: testCfg } = await supa
      .from("ph_config")
      .select("value")
      .eq("key", "_test_thread")
      .maybeSingle();
    if (testCfg?.value) {
      try {
        const t = JSON.parse(testCfg.value) as { thread_id?: string; to?: string };
        if (t.thread_id === msg.thread_id || (t.to && t.to.toLowerCase() === fromEmail)) {
          const { classifyReplyIntent } = await import("@/pipeline/inbound");
          const triage = await classifyReplyIntent({
            businessName: "TEST",
            lastSubject: msg.subject ?? "(test)",
            replyText: msg.extracted_text ?? msg.text ?? msg.preview ?? "",
          });
          const { logActivity } = await import("@/lib/activity");
          await logActivity(
            "inbound",
            `TEST reply from ${fromEmail} — ${triage.category}`,
            { snippet: (msg.extracted_text ?? msg.preview ?? "").slice(0, 200), test: true }
          );
          return NextResponse.json({ ok: true, matched: "test", category: triage.category });
        }
      } catch {
        /* fall through to unmatched */
      }
    }
    console.log(`webhook: inbound message on unmatched thread ${msg.thread_id} from ${fromEmail}`);
    return NextResponse.json({ ok: true, matched: false });
  }

  const { ph_partners: partner, ...outreachRow } = outreach as Outreach & { ph_partners: Partner };
  await handleReply({
    outreach: outreachRow as Outreach,
    partner,
    fromEmail,
    replyText: msg.extracted_text ?? msg.text ?? msg.preview ?? "",
    snippet: (msg.extracted_text ?? msg.preview ?? "").slice(0, 500),
    inboundMessageId: msg.message_id,
  });

  return NextResponse.json({ ok: true, matched: true });
}
