import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { Outreach, Partner } from "@/pipeline/types";
import { onboardPartner } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function PartnerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supa = db();
  const { data: partner } = await supa.from("ph_partners").select("*").eq("id", id).maybeSingle();
  if (!partner) notFound();
  const p = partner as Partner;

  const [{ data: outreach }, { data: clicks }] = await Promise.all([
    supa.from("ph_outreach").select("*").eq("partner_id", id).order("created_at", { ascending: true }),
    supa.from("ph_clicks").select("clicked_at").eq("partner_id", id).order("clicked_at", { ascending: false }),
  ]);
  const clickList = clicks ?? [];

  return (
    <>
      <h1>{p.business_name}</h1>
      <div className="card">
        <div className="row">
          <span className="pill pill-stage">{p.stage}</span>
          <span className="pill pill-stage">{p.segment} / {p.subtype ?? "?"}</span>
          {p.is_chain && <span className="pill pill-stage">chain</span>}
          <span className="pill pill-stage">score {p.fit_score ?? "—"}</span>
          {clickList.length > 0 && (
            <span className="pill pill-live">
              clicked {clickList.length}× · last {new Date(clickList[0].clicked_at).toLocaleDateString()}
            </span>
          )}
        </div>
        <p className="small">
          {p.city ? `${p.city}, ` : ""}{p.state ?? ""} · {p.website ?? "no website"} · {p.phone ?? "no phone"}
          <br />
          {p.email ?? "no email"} ({p.email_status}) {p.contact_name ? `· contact: ${p.contact_name}` : ""}
          <br />
          source: {p.source}
        </p>
        {p.enrichment?.business_detail ? (
          <p className="small muted">“{String(p.enrichment.business_detail)}”</p>
        ) : null}
        {p.sample_status !== "none" && (
          <p className="small">
            Sample: <strong>{p.sample_status}</strong>
            {p.sample_address ? ` → ${p.sample_address}` : ""}
          </p>
        )}
        {p.notes && <p className="small muted">{p.notes}</p>}
      </div>

      {["interested", "replied", "negotiating"].includes(p.stage) && (
        <div className="card warm">
          <h2 style={{ marginTop: 0 }}>Onboard this partner</h2>
          <p className="small muted">
            Drafts the onboarding reply into the approval queue — both fixed codes (STAR-M0234 gift +
            STAR-C6538 customer) and the demo link, explaining how to redeem the two free sets at the
            store (upload a pet, create the portraits, apply the code). You review and send; nothing
            auto-sends.
          </p>
          <form action={onboardPartner} className="row">
            <input type="hidden" name="partner_id" value={p.id} />
            <button className="primary">Draft onboarding reply</button>
          </form>
        </div>
      )}

      <h2>Outreach history</h2>
      {((outreach ?? []) as Outreach[]).map((o) => (
        <div className="card" key={o.id}>
          <div className="row">
            <strong>#{o.touch_number} · {o.subject}</strong>
            <span className="pill pill-stage">{o.status}</span>
            {o.is_reply_draft && <span className="pill pill-stage">reply</span>}
          </div>
          <p className="small muted">
            {o.sent_at ? `sent ${new Date(o.sent_at).toLocaleString()}` : `created ${new Date(o.created_at).toLocaleString()}`}
            {o.replied_at ? ` · replied ${new Date(o.replied_at).toLocaleString()}` : ""}
          </p>
          {o.body && <div className="email-body small">{o.body}</div>}
          {o.reply_snippet && (
            <>
              <p className="small muted">Their reply:</p>
              <div className="email-body small">{o.reply_snippet}</div>
            </>
          )}
        </div>
      ))}
      {(outreach ?? []).length === 0 && <p className="muted">No outreach yet.</p>}
    </>
  );
}
