import { replyToMessage, sendEmail } from "@/lib/agentmail";
import { isSendableStatus } from "@/lib/verify-email";
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
// Daily cap: ph_config.daily_send_cap is the live dial (changeable without a
// deploy, like the other autopilot knobs); falls back to the DAILY_SEND_CAP env
// var / default when the row is absent or unparseable.
export async function resolveDailyCap(): Promise<number> {
  const { data } = await db()
    .from("ph_config")
    .select("value")
    .eq("key", "daily_send_cap")
    .maybeSingle();
  const n = Number(data?.value);
  return Number.isFinite(n) && n > 0 ? n : dailySendCap();
}

// Current hour (0–23) in US Pacific time, DST-aware.
function pacificHour(d = new Date()): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hour12: false,
  }).format(d);
  const h = parseInt(s, 10);
  return Number.isFinite(h) ? (h === 24 ? 0 : h) : 0;
}

// Drip pacing (warm-up): send at most `send_per_tick` per cron invocation, and
// only when the Pacific hour is within [send_window_start_pt, send_window_end_pt]
// (inclusive). The first `send_boost_hours` of the window send `send_boost_per_tick`
// instead (e.g. 2/hour for the first 5 hours, then 1/hour) — lets the day be
// front-loaded while still spreading across the whole window. Defaults are
// wide-open (no per-tick limit, all hours, no boost) so unset config preserves
// the old "send the whole approved batch" behaviour.
async function resolveSendPacing(
  cap: number
): Promise<{ perTick: number; boostPerTick: number; boostHours: number; startPt: number; endPt: number }> {
  const { data } = await db()
    .from("ph_config")
    .select("key,value")
    .in("key", [
      "send_per_tick",
      "send_boost_per_tick",
      "send_boost_hours",
      "send_window_start_pt",
      "send_window_end_pt",
    ]);
  const m = new Map((data ?? []).map((r) => [r.key, Number(r.value)]));
  const num = (k: string) => {
    const v = m.get(k);
    return Number.isFinite(v) ? (v as number) : undefined;
  };
  const perTick = (num("send_per_tick") ?? 0) > 0 ? (num("send_per_tick") as number) : cap;
  return {
    perTick,
    boostPerTick: (num("send_boost_per_tick") ?? 0) > 0 ? (num("send_boost_per_tick") as number) : perTick,
    boostHours: (num("send_boost_hours") ?? 0) > 0 ? (num("send_boost_hours") as number) : 0,
    startPt: num("send_window_start_pt") ?? 0,
    endPt: num("send_window_end_pt") ?? 23,
  };
}

export async function runSend(): Promise<{ sent: number; dryRun: number; skipped: string[] }> {
  const supa = db();
  const cap = await resolveDailyCap();
  const already = await sentTodayCount();
  const skipped: string[] = [];
  let sent = 0;
  let dryRun = 0;

  if (already >= cap) return { sent, dryRun, skipped: [`daily cap reached (${already}/${cap})`] };

  const { perTick, boostPerTick, boostHours, startPt, endPt } = await resolveSendPacing(cap);
  const hr = pacificHour();
  if (hr < startPt || hr > endPt) {
    return { sent, dryRun, skipped: [`outside send window (PT hour ${hr}, window ${startPt}-${endPt})`] };
  }
  // The first `boostHours` hours of the window carry the boosted rate; the rest
  // use the standard per-tick. The daily cap is always the hard ceiling.
  const inBoost = boostHours > 0 && hr >= startPt && hr < startPt + boostHours;
  const effectivePerTick = inBoost ? boostPerTick : perTick;
  const batch = Math.min(cap - already, effectivePerTick);
  if (batch <= 0) return { sent, dryRun, skipped: [`per-tick limit reached (${effectivePerTick}/tick)`] };

  const { data: approved, error } = await supa
    .from("ph_outreach")
    .select("*, ph_partners(*)")
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(batch);
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
    if (!isSendableStatus(partner.email_status)) {
      skipped.push(`${row.id}: email not sendable (${partner.email_status})`);
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
      const { logActivity } = await import("@/lib/activity");
      await logActivity("send", `sent touch #${row.touch_number} to ${partner.business_name} <${email}>`);
      sent++;
    } catch (e) {
      console.error(`send: failed for outreach ${row.id}: ${(e as Error).message}`);
      skipped.push(`${row.id}: send error`);
    }
  }
  return { sent, dryRun, skipped };
}
