import { db } from "@/lib/supabase";
import { runStageAction } from "@/app/actions";

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

// Manual stage runner — the phone-friendly alternative to curl + CRON_SECRET.
export default async function RunPage() {
  const { data } = await db()
    .from("ph_config")
    .select("value")
    .eq("key", "_last_run_result")
    .maybeSingle();

  return (
    <>
      <h1>Run pipeline stages</h1>
      <p className="muted small">
        Runs execute synchronously — discover/enrich can take a couple of minutes. One at a time.
      </p>
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
      {data?.value ? (
        <div className="email-body small">{data.value}</div>
      ) : (
        <p className="muted">Nothing run yet.</p>
      )}
    </>
  );
}
