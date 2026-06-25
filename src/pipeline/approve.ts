import { db } from "@/lib/supabase";
import { isSendableStatus } from "@/lib/verify-email";
import { sendingEnabled } from "@/lib/env";

function pacificDayKey(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Warm-up auto-approval. Each Pacific day, approve up to `auto_approve_per_day`
// of the OLDEST first-touch drafts (sendable email, not flagged for attention)
// so the hourly send drip always has fuel without manual queue triage. Works
// down the queue from the top, day by day. Safety rails:
//   - only first-touch outreach (touch_number=1, not reply drafts) — replies and
//     attention-flagged items stay human-gated;
//   - only partners with a sendable (verified/catch_all) email;
//   - bounded to N per Pacific day via a per-day marker;
//   - off unless auto_approve_per_day > 0, and paused when sending is disabled.
export async function runAutoApprove(): Promise<{
  approved: number;
  disabled?: boolean;
  capReached?: boolean;
}> {
  const supa = db();
  if (!sendingEnabled()) return { approved: 0, disabled: true };

  const { data: cfg } = await supa
    .from("ph_config")
    .select("value")
    .eq("key", "auto_approve_per_day")
    .maybeSingle();
  const perDay = Number(cfg?.value);
  if (!Number.isFinite(perDay) || perDay <= 0) return { approved: 0, disabled: true };

  const markerKey = `_auto_approved_${pacificDayKey()}`;
  const { data: markerRow } = await supa
    .from("ph_config")
    .select("value")
    .eq("key", markerKey)
    .maybeSingle();
  const already = Number(markerRow?.value) || 0;
  if (already >= perDay) return { approved: 0, capReached: true };

  const want = perDay - already;
  const { data: candidates } = await supa
    .from("ph_outreach")
    .select("id, partner_id")
    .eq("status", "draft")
    .eq("needs_attention", false)
    .eq("is_reply_draft", false)
    .eq("touch_number", 1)
    .order("created_at", { ascending: true })
    .limit(want * 4);

  const partnerIds = [...new Set((candidates ?? []).map((c) => c.partner_id))];
  const { data: partnerRows } = partnerIds.length
    ? await supa.from("ph_partners").select("id,email_status").in("id", partnerIds)
    : { data: [] };
  const sendable = new Set(
    (partnerRows ?? []).filter((p) => isSendableStatus(p.email_status)).map((p) => p.id)
  );

  const ids: string[] = [];
  for (const c of candidates ?? []) {
    if (ids.length >= want) break;
    if (sendable.has(c.partner_id)) ids.push(c.id);
  }
  if (ids.length === 0) return { approved: 0 };

  await supa
    .from("ph_outreach")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "draft");
  await supa
    .from("ph_config")
    .upsert({ key: markerKey, value: String(already + ids.length), updated_at: new Date().toISOString() });

  const { logActivity } = await import("@/lib/activity");
  await logActivity(
    "approve",
    `auto-approved ${ids.length} first-touch draft(s) for the warm-up drip (${already + ids.length}/${perDay} today)`
  );
  return { approved: ids.length };
}
