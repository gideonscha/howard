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
  // for domain reputation on the Health view. AgentMail's payload shape for
  // recipients varies (string | {email} | {emailAddress} | {address}), so we
  // extract defensively and never throw (a 500 here makes AgentMail retry-storm).
  if (event.event_type === "message.bounced" || event.event_type === "message.complained") {
    const { logActivity } = await import("@/lib/activity");
    try {
      const info = (event.bounce ?? event.complaint ?? {}) as Record<string, unknown>;
      const ownDomain = (process.env.HOWARD_INBOX ?? "howard@magicportraitspartners.com").split("@")[1];

      // Structured extraction first.
      const rawRec = (info.recipients ?? info.recipient ?? []) as unknown;
      const recArr = Array.isArray(rawRec) ? rawRec : [rawRec];
      let emails = recArr
        .map((r) => {
          if (typeof r === "string") return r;
          if (r && typeof r === "object") {
            const o = r as Record<string, unknown>;
            return (o.email ?? o.emailAddress ?? o.address ?? o.recipient) as string | undefined;
          }
          return undefined;
        })
        .filter((e): e is string => typeof e === "string");

      // Fallback: scrape email-looking strings from the payload, excluding our
      // own inbox and SES/message-id infrastructure domains.
      if (emails.length === 0) {
        const found = JSON.stringify(event).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
        emails = found.filter(
          (e) => !/(amazonses\.com|amazonaws\.com)$/i.test(e) && !e.toLowerCase().endsWith(`@${ownDomain}`)
        );
      }
      emails = [...new Set(emails.map((e) => e.toLowerCase()))];

      await logActivity(
        "suppression",
        `${event.event_type} — ${emails.join(", ") || "unparsed recipient"}`,
        { raw: JSON.stringify(event).slice(0, 600) }
      );

      for (const email of emails) {
        const { error } = await supa.from("ph_suppression").insert({ email, reason: event.event_type });
        if (error && !error.message.includes("duplicate")) {
          console.error(`suppression insert failed for ${email}: ${error.message}`);
        }
        await supa
          .from("ph_partners")
          .update({ email_status: "invalid", updated_at: new Date().toISOString() })
          .ilike("email", email);
      }

      const threadId = (info.thread_id ?? info.threadId) as string | undefined;
      if (threadId) {
        await supa
          .from("ph_outreach")
          .update({ status: "bounced", updated_at: new Date().toISOString() })
          .eq("agentmail_thread_id", threadId)
          .eq("status", "sent");
      }
    } catch (e) {
      console.error(`bounce/complaint handler error: ${(e as Error).message}`);
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
