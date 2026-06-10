import { db } from "@/lib/supabase";
import { getProgress } from "@/lib/progress";
import { runStageAction } from "@/app/actions";
import { AutoRefresh } from "./refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STAGES: { stage: string; label: string; paramHint?: string; defaultParam?: string }[] = [
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
  const [progress, { data: last }] = await Promise.all([
    getProgress(),
    db().from("ph_config").select("value").eq("key", "_last_run_result").maybeSingle(),
  ]);

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

      <h2>Last run result</h2>
      {last?.value ? (
        <div className="email-body small">{last.value}</div>
      ) : (
        <p className="muted">Nothing run yet.</p>
      )}
    </>
  );
}
