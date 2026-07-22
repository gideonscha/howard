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

// Auto-approval. Each Pacific day, approve up to `auto_approve_per_day` drafts
// so the hourly send drip always has fuel without manual queue triage.
// CADENCE FOLLOW-UPS (touch 2-3, no-reply nudges) are approved FIRST — they
// out-convert cold first-touches — then first-touches fill the remainder.
// Safety rails:
//   - replies to real humans and anything attention-flagged stay human-gated
//     (both carry needs_attention=true); sample-arrival check-ins stay manual;
//   - a follow-up whose partner replies before send is auto-rejected by the
//     inbound handler, so cadence can't fire at someone mid-conversation;
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

  // Warm-up deliverability: when `warmup_major_hosted_only` is on, only approve
  // recipients hosted by tolerant major providers (Gmail/Workspace/M365/etc.).
  // Small self-hosted business servers greylist a young sending domain and time
  // out (transient 4.4.7). This defers — never discards — those prospects; they
  // stay as drafts until the flag is turned off once the domain is warmer.
  const { data: warmupRow } = await supa
    .from("ph_config")
    .select("value")
    .eq("key", "warmup_major_hosted_only")
    .maybeSingle();
  const majorOnly = String(warmupRow?.value).toLowerCase() === "true";

  const want = perDay - already;
  const fetchCap = want * (majorOnly ? 10 : 4);

  // Cadence follow-ups first (touch 2+, threaded, not sample check-ins) …
  const { data: followupCandidates } = await supa
    .from("ph_outreach")
    .select("id, partner_id, is_reply_draft")
    .eq("status", "draft")
    .eq("needs_attention", false)
    .eq("is_reply_draft", true)
    .gte("touch_number", 2)
    .not("subject", "ilike", "[sample follow-up]%")
    .order("created_at", { ascending: true })
    .limit(fetchCap);
  // … then fresh first-touches fill whatever budget remains.
  const { data: firstTouchCandidates } = await supa
    .from("ph_outreach")
    .select("id, partner_id, is_reply_draft")
    .eq("status", "draft")
    .eq("needs_attention", false)
    .eq("is_reply_draft", false)
    .eq("touch_number", 1)
    .order("created_at", { ascending: true })
    .limit(fetchCap);
  const candidates = [...(followupCandidates ?? []), ...(firstTouchCandidates ?? [])];

  const partnerIds = [...new Set((candidates ?? []).map((c) => c.partner_id))];
  const { data: partnerRows } = partnerIds.length
    ? await supa.from("ph_partners").select("id,email_status,email").in("id", partnerIds)
    : { data: [] };
  const byPartner = new Map((partnerRows ?? []).map((p) => [p.id, p]));

  const { isMajorHostedDomain } = majorOnly
    ? await import("@/lib/mail-host")
    : { isMajorHostedDomain: null };

  const ids: string[] = [];
  let followups = 0;
  let firstTouches = 0;
  let deferredSmallHost = 0;
  for (const c of candidates) {
    if (ids.length >= want) break;
    const partner = byPartner.get(c.partner_id);
    if (!partner || !isSendableStatus(partner.email_status)) continue;
    if (majorOnly && isMajorHostedDomain) {
      const domain = (partner.email ?? "").split("@")[1];
      if (!(await isMajorHostedDomain(domain))) {
        deferredSmallHost++;
        continue;
      }
    }
    ids.push(c.id);
    if (c.is_reply_draft) followups++;
    else firstTouches++;
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
    `auto-approved ${followups} follow-up(s) + ${firstTouches} first-touch(es) for the drip (${already + ids.length}/${perDay} today)` +
      (majorOnly ? ` · deferred ${deferredSmallHost} self-hosted-domain recipient(s)` : "")
  );
  return { approved: ids.length };
}
