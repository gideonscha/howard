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

// Two Places campaigns carry the volume now, swept at city/metro granularity:
// memorial and vet. The directory scrape sources (iaopcc/gateway) are
// exhausted — they returned only dupes while burning Firecrawl credits — so
// every cycle now runs a city-level Places slice (alternating memorial/vet).
const SOURCE_ROTATION = ["places", "places_vet", "places", "places_vet", "places", "places_vet"];

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
  const draftPerCycle = num(config.draft_per_cycle, 60);

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

  // 4. Draft a batch toward full coverage — every verified queued partner
  //    gets a first-touch draft (deduped per organisation), worked through in
  //    time-boxed per-cycle batches until none remain. No buffer floor.
  try {
    summary.draft = await runDraft(draftPerCycle);
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
