import { db } from "@/lib/supabase";
import { getProgress } from "@/lib/progress";
import { AutoRefresh } from "@/app/run/refresh";

export const dynamic = "force-dynamic";

const KIND_STYLE: Record<string, string> = {
  run: "pill-stage",
  autopilot: "pill-stage",
  send: "pill-live",
  inbound: "pill-hot",
  suppression: "pill-hot",
  error: "pill-hot",
};

function rel(at: string): string {
  const s = Math.round((Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Live system feed: what Howard is doing right now + everything he's done.
export default async function ActivityPage() {
  const [progress, { data: events }] = await Promise.all([
    getProgress(),
    db().from("ph_activity").select("*").order("at", { ascending: false }).limit(100),
  ]);

  const running = progress && !progress.text.includes("✅");

  return (
    <>
      <AutoRefresh seconds={5} />
      <h1>Activity</h1>

      <div className={`card ${running ? "warm" : ""}`}>
        <strong>Right now:</strong>{" "}
        {running ? (
          <>
            {progress.text} <span className="muted small">({rel(progress.at)})</span>
          </>
        ) : (
          <span className="muted">idle — next autopilot cycle at the top of the hour</span>
        )}
      </div>

      {(events ?? []).length === 0 ? (
        <p className="muted">No activity yet. The feed fills as runs, sends, and replies happen.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {(events ?? []).map((e) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: "nowrap" }} className="small muted">
                  {rel(e.at)}
                </td>
                <td>
                  <span className={`pill ${KIND_STYLE[e.kind] ?? "pill-stage"}`}>{e.kind}</span>{" "}
                  {e.message}
                  {e.data ? (
                    <details>
                      <summary className="small muted">details</summary>
                      <div className="email-body small">{JSON.stringify(e.data, null, 2)}</div>
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
