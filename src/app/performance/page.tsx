import { db, fetchAll } from "@/lib/supabase";
import { sendingEnabled } from "@/lib/env";
import { Partner } from "@/pipeline/types";

export const dynamic = "force-dynamic";

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
}

function sourceKey(source: string): string {
  return source.split(":")[0];
}

export default async function Performance() {
  const supa = db();
  const [partners, { data: referrals }] = await Promise.all([
    fetchAll<Partner>(() => supa.from("ph_partners").select("*")),
    supa.from("ph_referrals").select("*, ph_partners(business_name,segment,state)"),
  ]);

  const ps = partners as Partner[];
  const contactedStages = ["contacted", "replied", "negotiating", "signed", "live"];
  const repliedStages = ["replied", "negotiating", "signed", "live"];
  const anyContacted = ps.some((p) => contactedStages.includes(p.stage));

  // ── Sourcing performance (live from day one) ────────────────────────
  const bySource = new Map<
    string,
    { discovered: number; live: number; declined: number; verified: number; risky: number }
  >();
  for (const p of ps) {
    const key = sourceKey(p.source);
    const g = bySource.get(key) ?? { discovered: 0, live: 0, declined: 0, verified: 0, risky: 0 };
    g.discovered++;
    if (p.stage === "declined") g.declined++;
    else {
      g.live++;
      if (p.email_status === "verified") g.verified++;
      if (p.email_status === "risky") g.risky++;
    }
    bySource.set(key, g);
  }

  const ladder = new Map<string, number>();
  for (const p of ps) {
    if (!p.email || p.stage === "declined") continue;
    const src = (p.enrichment?.email_source as string | undefined) ?? "pre-tagging";
    ladder.set(src, (ladder.get(src) ?? 0) + 1);
  }

  // ── Outreach performance (activates with sending) ───────────────────
  const groups = new Map<string, { contacted: number; replied: number; samples: number; signed: number }>();
  for (const p of ps) {
    for (const key of [`source: ${sourceKey(p.source)}`, `segment: ${p.segment}`]) {
      const g = groups.get(key) ?? { contacted: 0, replied: 0, samples: 0, signed: 0 };
      if (contactedStages.includes(p.stage)) g.contacted++;
      if (repliedStages.includes(p.stage)) g.replied++;
      if (!["none", "offered"].includes(p.sample_status)) g.samples++;
      if (["signed", "live"].includes(p.stage)) g.signed++;
      groups.set(key, g);
    }
  }

  const totalRevenue = (referrals ?? []).reduce((s, r) => s + Number(r.revenue), 0);
  const totalOrders = (referrals ?? []).reduce((s, r) => s + Number(r.orders_count), 0);
  const signedCount = ps.filter((p) => ["signed", "live"].includes(p.stage)).length;

  return (
    <>
      <h1>Performance</h1>

      <h2>Sourcing performance</h2>
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Discovered</th>
            <th>Live</th>
            <th className="hide-mobile">Filtered out</th>
            <th>Verified</th>
            <th>Mailable rate</th>
          </tr>
        </thead>
        <tbody>
          {[...bySource.entries()]
            .sort((a, b) => b[1].live - a[1].live)
            .map(([src, g]) => (
              <tr key={src}>
                <td>{src}</td>
                <td>{g.discovered}</td>
                <td>{g.live}</td>
                <td className="hide-mobile">
                  {g.declined} <span className="muted small">({pct(g.declined, g.discovered)})</span>
                </td>
                <td>{g.verified}</td>
                <td>{pct(g.verified, g.live)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <p className="small muted">
        Filtered out = dedupe folds, non-US, suppliers, non-fits — the quality gates working.
      </p>

      <h2>Email ladder — where addresses come from</h2>
      <table>
        <thead>
          <tr>
            <th>Rung</th>
            <th>Emails found</th>
          </tr>
        </thead>
        <tbody>
          {[...ladder.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([src, n]) => (
              <tr key={src}>
                <td>
                  {src === "site" && "site-claimed (free)"}
                  {src === "contact_page" && "contact-page hunt (free)"}
                  {src === "hunter" && "Hunter.io (1 credit each)"}
                  {src === "pre-tagging" && "found before source tracking"}
                </td>
                <td>{n}</td>
              </tr>
            ))}
          {ladder.size === 0 && (
            <tr>
              <td colSpan={2} className="muted">No emails found yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Outreach funnel</h2>
      {!anyContacted ? (
        <p className="muted">
          Activates once sending begins — currently{" "}
          {sendingEnabled() ? "sending is on but nothing has been approved+sent yet" : "the kill-switch is off and nothing has been sent"}.
          Reply rate, sample-acceptance rate, and cost-per-signed-partner will populate here per source and segment.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Group</th>
              <th>Contacted</th>
              <th>Reply rate</th>
              <th>Sample rate</th>
              <th>Signed</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()]
              .filter(([, g]) => g.contacted > 0)
              .map(([key, g]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{g.contacted}</td>
                  <td>{pct(g.replied, g.contacted)}</td>
                  <td>{pct(g.samples, g.contacted)}</td>
                  <td>{g.signed}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      <h2>Revenue attribution</h2>
      {(referrals ?? []).length === 0 ? (
        <p className="muted">
          Activates when the first partner signs: their Shopify discount code is minted, and orders/revenue
          roll up here daily. {signedCount === 0 ? "No partners signed yet." : ""}
        </p>
      ) : (
        <>
          <div className="statgrid">
            <div className="stat"><div className="v">{signedCount}</div><div className="l">signed partners</div></div>
            <div className="stat"><div className="v">{totalOrders}</div><div className="l">attributed orders</div></div>
            <div className="stat"><div className="v">${totalRevenue.toFixed(0)}</div><div className="l">attributed revenue</div></div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Partner</th>
                <th>Code</th>
                <th>Orders</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {(referrals ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{(r.ph_partners as { business_name?: string })?.business_name ?? r.partner_id}</td>
                  <td>{r.discount_code}</td>
                  <td>{r.orders_count}</td>
                  <td>${Number(r.revenue).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
