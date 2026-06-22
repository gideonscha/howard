import { NextRequest, NextResponse } from "next/server";
import { runDiscover } from "@/pipeline/discover";
import { runEnrich } from "@/pipeline/enrich";
import { runScore } from "@/pipeline/score";
import { runDraft } from "@/pipeline/draft";
import { runSend } from "@/pipeline/send";
import { runFollowup } from "@/pipeline/followup";
import { runSign } from "@/pipeline/sign";
import { runAttribute } from "@/pipeline/attribute";
import { createInbox, createWebhook, howardInbox, sendEmail } from "@/lib/agentmail";
import { publicBaseUrl } from "@/lib/env";
import { db } from "@/lib/supabase";

export const maxDuration = 300;

// Manual stage trigger, e.g.:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     "https://<app>/api/run/discover?source=iaopcc"
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ stage: string }> }
) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { stage } = await params;
  const url = new URL(req.url);
  try {
    switch (stage) {
      case "discover":
        return NextResponse.json(await runDiscover(url.searchParams.get("source") ?? undefined));
      case "enrich":
        return NextResponse.json(await runEnrich(Number(url.searchParams.get("limit") ?? 10)));
      case "score":
        return NextResponse.json(await runScore());
      case "draft":
        return NextResponse.json(await runDraft(Number(url.searchParams.get("limit") ?? 5)));
      case "send":
        return NextResponse.json(await runSend());
      case "followup":
        return NextResponse.json(await runFollowup());
      case "attribute":
        return NextResponse.json(await runAttribute());
      case "sign": {
        const partnerId = url.searchParams.get("partner_id");
        if (!partnerId) return new NextResponse("partner_id required", { status: 400 });
        return NextResponse.json(await runSign(partnerId));
      }
      // One-time AgentMail provisioning (sandbox can't reach the API, so this
      // runs server-side). Returns the webhook secret to paste into Vercel.
      case "setup-agentmail": {
        let inboxResult: unknown;
        try {
          inboxResult = await createInbox();
        } catch (e) {
          inboxResult = `inbox create skipped: ${(e as Error).message} (already exists is fine)`;
        }
        const hookUrl = `${publicBaseUrl().replace(/\/$/, "")}/api/webhooks/agentmail`;
        const webhook = await createWebhook(hookUrl);
        return NextResponse.json({
          inbox: howardInbox(),
          inboxResult,
          webhook_id: webhook.webhook_id,
          hookUrl,
          AGENTMAIL_WEBHOOK_SECRET: webhook.secret,
          note: "Paste AGENTMAIL_WEBHOOK_SECRET into Vercel env, then redeploy.",
        });
      }
      // Safe test send: sends a real first-touch draft's body to an address you
      // supply, from howard@. Does NOT read SENDING_ENABLED, does NOT touch the
      // partner queue, and marks NO ph_outreach row as sent. Records the thread
      // in ph_config so a reply round-trips through the webhook for triage.
      case "test-send": {
        const to = url.searchParams.get("to");
        if (!to) return new NextResponse("to=<email> required", { status: 400 });
        const supa = db();
        const { data: draft } = await supa
          .from("ph_outreach")
          .select("subject,body")
          .eq("status", "draft")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!draft) return new NextResponse("no draft available to use as test body", { status: 400 });
        const result = await sendEmail({ to, subject: draft.subject, text: draft.body });
        await supa.from("ph_config").upsert({
          key: "_test_thread",
          value: JSON.stringify({
            thread_id: result.thread_id,
            message_id: result.message_id,
            to,
            at: new Date().toISOString(),
          }),
          updated_at: new Date().toISOString(),
        });
        const { logActivity } = await import("@/lib/activity");
        await logActivity("send", `TEST send to ${to} (subject: ${draft.subject})`, { test: true });
        return NextResponse.json({ test: true, to, subject: draft.subject, ...result });
      }
      default:
        return new NextResponse(`Unknown stage: ${stage}`, { status: 404 });
    }
  } catch (e) {
    console.error(`run/${stage} failed:`, e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
