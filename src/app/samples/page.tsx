import Link from "next/link";
import { db } from "@/lib/supabase";
import { Partner } from "@/pipeline/types";
import { markSampleDelivered, markSampleShipped } from "@/app/actions";

export const dynamic = "force-dynamic";

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

// Star in Heaven sample tracker — Gideon's fulfillment to-do list.
export default async function Samples() {
  const { data } = await db()
    .from("ph_partners")
    .select("*")
    .neq("sample_status", "none")
    .order("updated_at", { ascending: false });

  const partners = (data ?? []) as Partner[];
  const requested = partners.filter((p) => p.sample_status === "requested");
  const shipped = partners.filter((p) => p.sample_status === "shipped");
  const delivered = partners.filter((p) => p.sample_status === "delivered");
  const offered = partners.filter((p) => p.sample_status === "offered");

  return (
    <>
      <h1>Star in Heaven samples</h1>
      <div className="statgrid">
        <div className="stat"><div className="v">{requested.length}</div><div className="l">requested — ship these</div></div>
        <div className="stat"><div className="v">{shipped.length}</div><div className="l">shipped</div></div>
        <div className="stat"><div className="v">{delivered.length}</div><div className="l">delivered</div></div>
        <div className="stat"><div className="v">{offered.length}</div><div className="l">offered</div></div>
      </div>

      {requested.length > 0 && <h2>🔥 To ship</h2>}
      {requested.map((p) => (
        <div className="card hot" key={p.id}>
          <div className="row">
            <strong><Link href={`/pipeline/${p.id}`}>{p.business_name}</Link></strong>
            <span className="pill pill-hot">requested</span>
          </div>
          <p className="small">{p.sample_address ?? "⚠️ no address captured — open the thread"}</p>
          <form action={markSampleShipped}>
            <input type="hidden" name="partner_id" value={p.id} />
            <button className="primary">Mark shipped</button>
          </form>
        </div>
      ))}

      {shipped.length > 0 && <h2>In transit / awaiting follow-up</h2>}
      {shipped.map((p) => {
        const d = daysSince(p.sample_shipped_at);
        return (
          <div className="card warm" key={p.id}>
            <div className="row">
              <strong><Link href={`/pipeline/${p.id}`}>{p.business_name}</Link></strong>
              <span className="pill pill-stage">
                shipped {d != null ? `${d}d ago` : ""}
                {d != null && d >= 5 ? " · follow-up due" : ""}
              </span>
            </div>
            <p className="small muted">{p.sample_address}</p>
            <form action={markSampleDelivered}>
              <input type="hidden" name="partner_id" value={p.id} />
              <button>Mark delivered</button>
            </form>
          </div>
        );
      })}

      {delivered.length > 0 && <h2>Delivered</h2>}
      {delivered.map((p) => (
        <div className="card" key={p.id}>
          <div className="row">
            <strong><Link href={`/pipeline/${p.id}`}>{p.business_name}</Link></strong>
            <span className="pill pill-stage">delivered</span>
          </div>
        </div>
      ))}

      {partners.length === 0 && (
        <p className="muted">No sample activity yet. Sample requests land here the moment a partner asks.</p>
      )}
    </>
  );
}
