import Link from "next/link";
import { db } from "@/lib/supabase";
import { getProgress } from "@/lib/progress";

const KIND_STYLE: Record<string, string> = {
  run: "pill-stage",
  autopilot: "pill-stage",
  send: "pill-live",
  approve: "pill-live",
  inbound: "pill-hot",
  suppression: "pill-hot",
  error: "pill-hot",
};

export function rel(at: string): string {
  const s = Math.round((Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Shared activity feed: full mode on /activity, compact widget on /metrics.
export async function ActivityFeed({
  limit = 100,
  compact = false,
}: {
  limit?: number;
  compact?: boolean;
}) {
  const [progress, { data: rawEvents }] = await Promise.all([
    getProgress(),
    db().from("ph_activity").select("*").order("at", { ascending: false }).limit(limit),
  ]);

  // Compact mode: autopilot cycles repeat hourly — show only the latest one
  // so the widget surfaces signal (sends, replies, errors), not heartbeat.
  let events = rawEvents ?? [];
  if (compact) {
    let autopilotSeen = false;
    events = events.filter((e) => {
      if (e.kind !== "autopilot") return true;
      if (autopilotSeen) return false;
      autopilotSeen = true;
      return true;
    });
  }

  const running = progress && !progress.text.includes("✅");

  return (
    <>
      <div className={`card ${running ? "warm" : ""}`} style={compact ? { marginBottom: 8 } : undefined}>
        <strong>Right now:</strong>{" "}
        {running ? (
          <>
            {progress.text} <span className="muted small">({rel(progress.at)})</span>
          </>
        ) : (
          <span className="muted">idle — next autopilot cycle at the top of the hour</span>
        )}
        {compact && (
          <span className="small" style={{ float: "right" }}>
            <Link href="/activity">full feed →</Link>
          </span>
        )}
      </div>

      {(events ?? []).length === 0 ? (
        <p className="muted">No activity yet. The feed fills as runs, sends, and replies happen.</p>
      ) : (
        <table>
          {!compact && (
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
              </tr>
            </thead>
          )}
          <tbody>
            {(events ?? []).map((e) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: "nowrap" }} className="small muted">
                  {rel(e.at)}
                </td>
                <td className={compact ? "small" : undefined}>
                  <span className={`pill ${KIND_STYLE[e.kind] ?? "pill-stage"}`}>{e.kind}</span>{" "}
                  {e.message}
                  {!compact && e.data ? (
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
