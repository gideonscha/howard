import { db } from "@/lib/supabase";
import { getProgress } from "@/lib/progress";
import { runStageAction } from "@/app/actions";
import { AutoRefresh } from "./refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const STAGES: { stage: string; label: string; paramHint?: string; defaultParam?: string }[] = [
  { stage: "pipeline", label: "▶ Full pipeline (discover→enrich→score→draft)" },
  { stage: "discover", label: "Discover", paramHint: "source: iaopcc | gateway | lapoflove", defaultParam: "iaopcc" },
  { stage: "enrich", label: "Enrich", paramHint: "limit", defaultParam: "10" },
  { stage: "score", label: "Score" },
  { stage: "draft", label: "Draft", paramHint: "limit", defaultParam: "5" },
  { stage: "send", label: "Send (kill-switch gated)" },
  { stage: "followup", label: "Follow-up (kill-switch gated)" },
  { stage: "attribute", label: "Attribute (Shopify sync)" },
];

// Manual stage runner. Stages run in the background; this page live-refreshes
// with progress and the final result.
export default async function RunPage() {
  const [progress, { data: last }, { data: apLast }, { count: warehouse }, { data: targetRow }] =
    await Promise.all([
      getProgress(),
      db().from("ph_config").select("value").eq("key", "_last_run_result").maybeSingle(),
      db().from("ph_config").select("value").eq("key", "_autopilot_last").maybeSingle(),
      db()
        .from("ph_partners")
        .select("id", { count: "exact", head: true })
        .in("stage", ["qualified", "queued", "contacted", "replied", "negotiating", "signed", "live"])
        .or("email_status.eq.verified,fit_score.gte.60"),
      db().from("ph_config").select("value").eq("key", "prospect_target").maybeSingle(),
    ]);
  const target = Number(targetRow?.value) || 2000;

  const running = progress && !progress.text.includes("✅");
  const ageSec = progress ? Math.round((Date.now() - new Date(progress.at).getTime()) / 1000) : null;

  return (
    <>
      <AutoRefresh seconds={5} />
      <h1>Run pipeline stages</h1>

      <div className={`card ${running ? "warm" : ""}`}>
        <strong>Status:</strong>{" "}
        {progress ? (
          <>
            {progress.text}{" "}
            <span className="muted small">
              ({ageSec}s ago{running && ageSec != null && ageSec > 360 ? " — likely timed out, check result below / rerun" : ""})
            </span>
          </>
        ) : (
          <span className="muted">idle — nothing run yet</span>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          This page refreshes itself every 5s. Runs continue in the background after the button
          returns; discover processes up to 100 pages per tap and resumes on the next tap.
          Build: <code>{process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local"}</code> — if this
          doesn&apos;t match the latest deploy, reload the page before tapping.
        </p>
      </div>

      {STAGES.map((s) => (
        <form action={runStageAction} className="card row" key={s.stage}>
          <input type="hidden" name="stage" value={s.stage} />
          <button className="primary">{s.label}</button>
          {s.paramHint && (
            <input
              type="text"
              name="param"
              defaultValue={s.defaultParam}
              placeholder={s.paramHint}
              style={{ maxWidth: 220 }}
            />
          )}
          {s.paramHint && <span className="small muted">{s.paramHint}</span>}
        </form>
      ))}

      <h2>Autopilot</h2>
      <div className="card">
        <div className="row">
          <strong>Warehouse: {warehouse ?? 0} / {target}</strong>
          <span className="pill pill-stage">runs hourly with the cron tick</span>
        </div>
        <p className="muted small">
          Each hour: discover a slice (rotating source, daily credit budget) → enrich → score →
          top up the draft pile. List-building only — sending stays approval-gated and behind the
          kill-switch. Tune via ph_config: prospect_target, autopilot_daily_credits,
          autopilot_enrich_per_tick, draft_queue_floor, autopilot_enabled.
        </p>
        {apLast?.value && <div className="email-body small">{apLast.value}</div>}
      </div>

      <h2>Last run result</h2>
      {last?.value ? (
        <div className="email-body small">{last.value}</div>
      ) : (
        <p className="muted">Nothing run yet.</p>
      )}
    </>
  );
}
