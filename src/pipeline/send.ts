import { replyToMessage, sendEmail } from "@/lib/agentmail";
import { dailySendCap } from "@/lib/env";
import { gateSend } from "@/lib/killswitch";
import { db } from "@/lib/supabase";
import { Outreach, Partner } from "./types";

async function sentTodayCount(): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db()
    .from("ph_send_log")
    .select("id", { count: "exact", head: true })
    .eq("dry_run", false)
    .gte("sent_at", midnight.toISOString());
  if (error) throw error;
  return count ?? 0;
}

// Sends approved outreach. Gated by SENDING_ENABLED; enforces the daily cap;
// refuses non-verified emails and suppressed addresses; appends CAN-SPAM footer
// (in lib/agentmail). Approved-only: nothing leaves without Gideon's approval.
export async function runSend(): Promise<{ sent: number; dryRun: number; skipped: string[] }> {
  const supa = db();
  const cap = dailySendCap();
  const already = await sentTodayCount();
  const skipped: string[] = [];
  let sent = 0;
  let dryRun = 0;

  if (already >= cap) return { sent, dryRun, skipped: [`daily cap reached (${already}/${cap})`] };

  const { data: approved, error } = await supa
    .from("ph_outreach")
    .select("*, ph_partners(*)")
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(cap - already);
  if (error) throw error;

  const { data: suppressed } = await supa.from("ph_suppression").select("email,domain");
  const suppressedEmails = new Set((suppressed ?? []).map((s) => s.email?.toLowerCase()).filter(Boolean));
  const suppressedDomains = new Set((suppressed ?? []).map((s) => s.domain?.toLowerCase()).filter(Boolean));

  for (const row of (approved ?? []) as (Outreach & { ph_partners: Partner })[]) {
    const partner = row.ph_partners;
    const email = partner.email?.toLowerCase();

    if (!email) {
      skipped.push(`${row.id}: no email`);
      continue;
    }
    if (partner.email_status !== "verified") {
      skipped.push(`${row.id}: email not verified (${partner.email_status})`);
      continue;
    }
    const domain = email.split("@")[1];
    if (suppressedEmails.has(email) || (domain && suppressedDomains.has(domain))) {
      skipped.push(`${row.id}: suppressed`);
      continue;
    }
    if (["replied", "negotiating", "signed", "live", "declined"].includes(partner.stage) && !row.is_reply_draft) {
      skipped.push(`${row.id}: partner stage ${partner.stage} — cadence stopped`);
      continue;
    }

    const gate = await gateSend(row.id, email);
    if (!gate.allowed) {
      dryRun++;
      continue;
    }

    try {
      const result = row.is_reply_draft && row.agentmail_message_id
        ? await replyToMessage({ messageId: row.agentmail_message_id, to: email, text: row.body })
        : await sendEmail({ to: email, subject: row.subject, text: row.body });

      await supa
        .from("ph_outreach")
        .update({
          status: "sent",
          agentmail_thread_id: result.thread_id,
          agentmail_message_id: result.message_id,
          sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (!row.is_reply_draft) {
        await supa
          .from("ph_partners")
          .update({ stage: "contacted", updated_at: new Date().toISOString() })
          .eq("id", partner.id);
      }
      await supa.from("ph_send_log").insert({ outreach_id: row.id, email, dry_run: false });
      sent++;
    } catch (e) {
      console.error(`send: failed for outreach ${row.id}: ${(e as Error).message}`);
      skipped.push(`${row.id}: send error`);
    }
  }
  return { sent, dryRun, skipped };
}
