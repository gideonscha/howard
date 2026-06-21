import { db } from "@/lib/supabase";
import { dailySendCap, sendingEnabled } from "@/lib/env";

export const dynamic = "force-dynamic";

// Daily-cap usage, bounce rate, suppression count, send status, kill-switch.
// Bounce rate is the domain-reputation early warning.
export default async function Health() {
  const supa = db();
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);

  const [
    sentToday,
    dryToday,
    { count: suppression },
    { count: totalSent },
    { count: bounced },
    { data: recentLog },
    { count: contactedCount },
    { count: clickRows },
    { data: clickPartners },
    { count: repliedCount },
    { count: redeemedCount },
  ] = await Promise.all([
    supa.from("ph_send_log").select("id", { count: "exact", head: true }).eq("dry_run", false).gte("sent_at", midnight.toISOString()),
    supa.from("ph_send_log").select("id", { count: "exact", head: true }).eq("dry_run", true).gte("sent_at", midnight.toISOString()),
    supa.from("ph_suppression").select("id", { count: "exact", head: true }),
    supa.from("ph_outreach").select("id", { count: "exact", head: true }).in("status", ["sent", "replied", "bounced"]),
    supa.from("ph_outreach").select("id", { count: "exact", head: true }).eq("status", "bounced"),
    supa.from("ph_send_log").select("*").order("sent_at", { ascending: false }).limit(30),
    supa.from("ph_partners").select("id", { count: "exact", head: true }).in("stage", ["contacted", "replied", "negotiating", "signed", "live"]),
    supa.from("ph_clicks").select("id", { count: "exact", head: true }),
    supa.from("ph_clicks").select("partner_id"),
    supa.from("ph_partners").select("id", { count: "exact", head: true }).in("stage", ["replied", "negotiating", "signed", "live"]),
    supa.from("ph_referrals").select("id", { count: "exact", head: true }).gt("orders_count", 0),
  ]);
  const uniqueClickers = new Set((clickPartners ?? []).map((c) => c.partner_id).filter(Boolean)).size;

  const cap = dailySendCap();
  const live = sendingEnabled();
  const bounceRate = (totalSent ?? 0) === 0 ? 0 : ((bounced ?? 0) / (totalSent ?? 1)) * 100;
  const sent = sentToday.count ?? 0;
  const dry = dryToday.count ?? 0;
  const bouncedCount = bounced ?? 0;
  const totalSentCount = totalSent ?? 0;

  return (
    <>
      <h1>Health</h1>
      <div className="statgrid">
        <div className="stat">
          <div className="v">{live ? "ON" : "OFF"}</div>
          <div className="l">SENDING_ENABLED {live ? "— emails leave AgentMail" : "— dry-run only"}</div>
        </div>
        <div className="stat">
          <div className="v">{sent}/{cap}</div>
          <div className="l">daily cap used</div>
        </div>
        <div className="stat">
          <div className="v">{dry}</div>
          <div className="l">dry-run sends today</div>
        </div>
        <div className="stat">
          <div className="v" style={{ color: bounceRate > 2 ? "var(--hot)" : "inherit" }}>
            {totalSentCount === 0 ? "—" : `${bounceRate.toFixed(1)}%`}
          </div>
          <div className="l">bounce rate (keep &lt; 2%)</div>
        </div>
        <div className="stat">
          <div className="v">{suppression ?? 0}</div>
          <div className="l">suppressed addresses</div>
        </div>
        <div className="stat">
          <div className="v">{bouncedCount}</div>
          <div className="l">bounced total</div>
        </div>
      </div>

      <h2>Engagement funnel</h2>
      <div className="statgrid">
        <div className="stat"><div className="v">{contactedCount ?? 0}</div><div className="l">contacted (sent)</div></div>
        <div className="stat"><div className="v">{uniqueClickers}</div><div className="l">partners clicked</div></div>
        <div className="stat"><div className="v">{clickRows ?? 0}</div><div className="l">total link clicks</div></div>
        <div className="stat"><div className="v">{repliedCount ?? 0}</div><div className="l">replied</div></div>
        <div className="stat"><div className="v">{redeemedCount ?? 0}</div><div className="l">redeemed (≥1 order)</div></div>
      </div>
      <p className="small muted">
        Clicks are the reliable, deliverability-safe engagement signal (no open-tracking pixels — Apple
        MPP makes opens unreliable and pixels hurt a fresh domain). Funnel: sent → clicked → replied → redeemed.
      </p>

      <h2>Recent send log</h2>
      {(recentLog ?? []).length === 0 ? (
        <p className="muted">Nothing sent or dry-run yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When (UTC)</th>
              <th>To</th>
              <th>Mode</th>
            </tr>
          </thead>
          <tbody>
            {(recentLog ?? []).map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.sent_at).toISOString().replace("T", " ").slice(0, 16)}</td>
                <td>{l.email}</td>
                <td>{l.dry_run ? <span className="pill pill-dark">dry-run</span> : <span className="pill pill-live">sent</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
