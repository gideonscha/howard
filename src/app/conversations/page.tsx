import { Fragment } from "react";
import { db, fetchAll } from "@/lib/supabase";
import { Outreach, Partner } from "@/pipeline/types";

export const dynamic = "force-dynamic";

type Row = Outreach & { ph_partners: Partner };

function fmt(s: string | null): string {
  return s ? new Date(s).toLocaleString() : "";
}

function activityTs(r: Row): number {
  return Math.max(
    r.replied_at ? Date.parse(r.replied_at) : 0,
    r.sent_at ? Date.parse(r.sent_at) : 0,
    r.created_at ? Date.parse(r.created_at) : 0
  );
}

// Conversation thread per partner: every outbound touch we've sent (and any
// pending reply draft), interleaved with inbound replies. Built to be ready for
// when replies start landing — empty until then.
export default async function Conversations() {
  const supa = db();
  const rows = await fetchAll<Row>(() =>
    supa
      .from("ph_outreach")
      .select("*, ph_partners(*)")
      .or("sent_at.not.is.null,reply_snippet.not.is.null,is_reply_draft.eq.true")
      .order("created_at", { ascending: true })
  );

  const byPartner = new Map<string, { partner: Partner; rows: Row[] }>();
  for (const r of rows) {
    if (!r.ph_partners) continue;
    const g = byPartner.get(r.partner_id) ?? { partner: r.ph_partners, rows: [] };
    g.rows.push(r);
    byPartner.set(r.partner_id, g);
  }
  const convos = [...byPartner.values()].sort(
    (a, b) => Math.max(...b.rows.map(activityTs)) - Math.max(...a.rows.map(activityTs))
  );

  const totalReplies = rows.filter((r) => r.reply_snippet).length;
  const totalSent = rows.filter((r) => r.sent_at).length;

  return (
    <>
      <h1>Conversations</h1>
      <p className="muted small">
        Every outbound touch and any inbound reply, grouped by partner and ordered by most recent
        activity. {convos.length} {convos.length === 1 ? "thread" : "threads"} · {totalSent} sent ·{" "}
        {totalReplies} {totalReplies === 1 ? "reply" : "replies"}.
      </p>

      {convos.length === 0 && (
        <p className="muted">
          No conversations yet — sent emails and any replies will appear here once Howard starts
          reaching out.
        </p>
      )}

      {convos.map(({ partner, rows }) => (
        <div className="card" key={partner.id}>
          <div className="row">
            <strong>{partner.business_name}</strong>
            <span className="pill pill-stage">{partner.stage}</span>
            <span className="pill pill-stage">
              {partner.city ? `${partner.city}, ${partner.state ?? ""}` : partner.state ?? ""}
            </span>
            <span className="small muted">{partner.email ?? "no email"}</span>
          </div>

          {rows.map((r) => (
            <Fragment key={r.id}>
              {/* Outbound: a sent email, or a reply draft still pending */}
              <div
                style={{
                  borderLeft: "3px solid #8a5a2b",
                  paddingLeft: 10,
                  margin: "10px 0 4px",
                }}
              >
                <div className="small muted">
                  Howard → {partner.business_name} · touch #{r.touch_number}
                  {r.is_reply_draft ? " · reply" : ""} ·{" "}
                  {r.sent_at ? `sent ${fmt(r.sent_at)}` : `not sent yet (${r.status})`}
                </div>
                <div className="small">
                  <strong>{r.subject}</strong>
                </div>
                {r.body && <div className="email-body small">{r.body}</div>}
              </div>

              {/* Inbound: the partner's reply, if any */}
              {r.reply_snippet && (
                <div
                  style={{
                    borderLeft: "3px solid #1a7f4b",
                    paddingLeft: 10,
                    margin: "4px 0 10px 24px",
                    background: "#f6faf7",
                  }}
                >
                  <div className="small muted">
                    {partner.business_name} → Howard ·{" "}
                    {r.replied_at ? `replied ${fmt(r.replied_at)}` : "replied"}
                  </div>
                  <div className="email-body small">{r.reply_snippet}</div>
                </div>
              )}
            </Fragment>
          ))}
        </div>
      ))}
    </>
  );
}
