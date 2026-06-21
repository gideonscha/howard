import { db } from "@/lib/supabase";
import { getConfig } from "@/lib/config";
import { setProgress } from "@/lib/progress";
import { runDiscover } from "./discover";
import { runEnrich } from "./enrich";
import { runScore } from "./score";
import { runDraft } from "./draft";

// Prospecting autopilot: list-building only. Sending stays approval-gated,
// capped, and behind SENDING_ENABLED — autonomy never touches the outbox.
//
// ph_config knobs (all optional):
//   autopilot_enabled        'true' | 'false'        (default true)
//   prospect_target          warehouse goal          (default 2000)
//   autopilot_daily_credits  Firecrawl credits/day   (default 400)
//   autopilot_enrich_per_tick                        (default 15)
//   draft_queue_floor        drafts kept pending     (default 10)

// Places is the volume source — it gets most of the rotation. The scrape
// sources are exhausted (return only dupes), so they get one slot each as a
// cheap re-check; lapoflove dropped entirely (returned 0 for days).
const SOURCE_ROTATION = ["places", "places", "iaopcc", "places", "places", "gateway"];

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function prospectCount(): Promise<number> {
  const { count } = await db()
    .from("ph_partners")
    .select("id", { count: "exact", head: true })
    .in("stage", ["qualified", "queued", "contacted", "replied", "negotiating", "signed", "live"])
    .or("email_status.eq.verified,fit_score.gte.60");
  return count ?? 0;
}

async function creditsSpentToday(config: Record<string, string>): Promise<{ key: string; spent: number }> {
  const key = `_ap_credits_${new Date().toISOString().slice(0, 10)}`;
  return { key, spent: num(config[key], 0) || 0 };
}

export async function runAutopilot(): Promise<Record<string, unknown>> {
  const supa = db();
  const config = await getConfig();
  if ((config.autopilot_enabled ?? "true") === "false") {
    return { autopilot: "disabled" };
  }

  const target = num(config.prospect_target, 2000);
  const dailyCredits = num(config.autopilot_daily_credits, 400);
  const enrichPerTick = num(config.autopilot_enrich_per_tick, 15);
  const draftFloor = num(config.draft_queue_floor, 10);

  const summary: Record<string, unknown> = {};
  const warehouse = await prospectCount();
  summary.warehouse = `${warehouse}/${target}`;

  // 1. Discover — only while below target and within the daily credit budget.
  if (warehouse < target) {
    const { key, spent } = await creditsSpentToday(config);
    const remaining = dailyCredits - spent;
    if (remaining >= 25) {
      const source = SOURCE_ROTATION[new Date().getUTCHours() % SOURCE_ROTATION.length];
      try {
        const r = await runDiscover(source, Math.min(remaining, 150));
        summary.discover = r;
        await supa.from("ph_config").upsert({
          key,
          value: String(spent + r.creditsSpent),
          updated_at: new Date().toISOString(),
        });
      } catch (e) {
        summary.discover = { error: (e as Error).message };
      }
    } else {
      summary.discover = `skipped — daily credit budget spent (${spent}/${dailyCredits})`;
    }
  } else {
    summary.discover = "skipped — target reached";
  }

  // 2. Enrich a batch of whatever discovery produced.
  try {
    summary.enrich = await runEnrich(enrichPerTick);
  } catch (e) {
    summary.enrich = { error: (e as Error).message };
  }

  // 3. Re-score the queue.
  try {
    summary.score = await runScore();
  } catch (e) {
    summary.score = { error: (e as Error).message };
  }

  // 4. Keep the approval pile topped up with fresh first-touch drafts.
  try {
    const { count: pendingDrafts } = await supa
      .from("ph_outreach")
      .select("id", { count: "exact", head: true })
      .eq("status", "draft");
    const gap = draftFloor - (pendingDrafts ?? 0);
    summary.draft = gap > 0 ? await runDraft(gap) : `skipped — ${pendingDrafts} drafts pending (floor ${draftFloor})`;
  } catch (e) {
    summary.draft = { error: (e as Error).message };
  }

  await supa.from("ph_config").upsert({
    key: "_autopilot_last",
    value: JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2),
    updated_at: new Date().toISOString(),
  });
  const { logActivity } = await import("@/lib/activity");
  await logActivity("autopilot", `autopilot cycle — warehouse ${summary.warehouse}`, summary);
  await setProgress("autopilot: ✅ finished");
  return summary;
}
