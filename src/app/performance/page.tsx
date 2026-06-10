import { db } from "@/lib/supabase";
import { Partner } from "@/pipeline/types";

export const dynamic = "force-dynamic";

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
}

function sourceKey(source: string): string {
  return source.split(":")[0];
}

// Reply rate + sample-acceptance by source/segment, revenue per partner,
// renders empty-state gracefully until data exists.
export default async function Performance() {
  const supa = db();
  const [{ data: partners }, { data: referrals }] = await Promise.all([
    supa.from("ph_partners").select("*"),
    supa.from("ph_referrals").select("*, ph_partners(business_name,segment,state)"),
  ]);

  const ps = (partners ?? []) as Partner[];
  const contactedStages = ["contacted", "replied", "negotiating", "signed", "live"];
  const repliedStages = ["replied", "negotiating", "signed", "live"];

  const groups = new Map<string, { contacted: number; replied: number; samples: number; signed: number }>();
  for (const p of ps) {
    const keys = [`source: ${sourceKey(p.source)}`, `segment: ${p.segment}`];
    for (const key of keys) {
      const g = groups.get(key) ?? { contacted: 0, replied: 0, samples: 0, signed: 0 };
      if (contactedStages.includes(p.stage)) g.contacted++;
      if (repliedStages.includes(p.stage)) g.replied++;
      if (p.sample_status !== "none" && p.sample_status !== "offered") g.samples++;
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
      <div className="statgrid">
        <div className="stat"><div className="v">{signedCount}</div><div className="l">signed partners</div></div>
        <div className="stat"><div className="v">{totalOrders}</div><div className="l">attributed orders</div></div>
        <div className="stat"><div className="v">${totalRevenue.toFixed(0)}</div><div className="l">attributed revenue</div></div>
        <div className="stat">
          <div className="v">{signedCount ? `$${(totalRevenue / signedCount).toFixed(0)}` : "—"}</div>
          <div className="l">revenue / signed partner</div>
        </div>
      </div>

      <h2>Funnel by source & segment</h2>
      {groups.size === 0 ? (
        <p className="muted">No outreach data yet — this view fills in once partners are contacted.</p>
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
            {[...groups.entries()].map(([key, g]) => (
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

      <h2>Revenue by partner</h2>
      {(referrals ?? []).length === 0 ? (
        <p className="muted">No referral codes minted yet. Sign a partner to start attribution.</p>
      ) : (
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
      )}
    </>
  );
}
