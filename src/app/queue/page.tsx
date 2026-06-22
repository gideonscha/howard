import { db } from "@/lib/supabase";
import { Outreach, Partner } from "@/pipeline/types";
import {
  approveDraft,
  dismissAttention,
  markSampleShipped,
  onboardPartner,
  rejectDraft,
} from "@/app/actions";

export const dynamic = "force-dynamic";

type Row = Outreach & { ph_partners: Partner };

// Action queue (home): everything needing Gideon, heat-sorted —
// sample requests → escalations → replies → drafts pending approval.
export default async function ActionQueue() {
  const supa = db();
  const [{ data: attention }, { data: drafts }, { data: sampleRequests }, { data: interested }] =
    await Promise.all([
      supa
        .from("ph_outreach")
        .select("*, ph_partners(*)")
        .eq("needs_attention", true)
        .order("created_at", { ascending: false }),
      supa
        .from("ph_outreach")
        .select("*, ph_partners(*)")
        .eq("status", "draft")
        .eq("needs_attention", false)
        .order("created_at", { ascending: true })
        .limit(25),
      supa
        .from("ph_partners")
        .select("*")
        .eq("sample_status", "requested")
        .order("updated_at", { ascending: false }),
      supa
        .from("ph_partners")
        .select("*")
        .eq("stage", "interested")
        .order("updated_at", { ascending: false }),
    ]);

  const interestedRows = (interested ?? []) as Partner[];
  const attentionRows = (attention ?? []) as Row[];
  const samples = attentionRows.filter((r) => r.attention_reason?.startsWith("SAMPLE REQUEST"));
  const escalations = attentionRows.filter((r) => r.attention_reason?.startsWith("ESCALATION"));
  const otherAttention = attentionRows.filter((r) => !samples.includes(r) && !escalations.includes(r));
  const draftRows = (drafts ?? []) as Row[];

  return (
    <>
      <h1>Action queue</h1>

      {attentionRows.length === 0 && draftRows.length === 0 && interestedRows.length === 0 && (
        <p className="muted">Nothing needs you right now. Howard is working the pipeline.</p>
      )}

      {interestedRows.length > 0 && <h2>🎉 Interested — ready to onboard</h2>}
      {interestedRows.map((p) => (
        <div className="card hot" key={p.id}>
          <div className="row">
            <strong>{p.business_name}</strong>
            <span className="pill pill-hot">interested</span>
            <span className="pill pill-stage">
              {p.city ? `${p.city}, ${p.state}` : p.state ?? ""} · {p.segment}
            </span>
          </div>
          {p.email && <p className="small muted">{p.email}</p>}
          <ReplyContext partnerId={p.id} />
          <p className="small muted">
            Onboard drafts the reply into the queue — both codes ({"STAR-M0234"} gift +{" "}
            {"STAR-C6538"} customer) and the demo link, with how to redeem the free sets at the
            store. You review and send; nothing auto-sends.
          </p>
          <form action={onboardPartner}>
            <input type="hidden" name="partner_id" value={p.id} />
            <button className="primary">Draft onboarding reply</button>
          </form>
        </div>
      ))}

      {samples.length > 0 && <h2>🔥 Sample requests</h2>}
      {samples.map((r) => (
        <DraftCard key={r.id} row={r} hot />
      ))}

      {(sampleRequests ?? []).filter(
        (p) => !samples.some((s) => s.partner_id === p.id)
      ).length > 0 && (
        <>
          <h2>Samples awaiting shipment</h2>
          {((sampleRequests ?? []) as Partner[])
            .filter((p) => !samples.some((s) => s.partner_id === p.id))
            .map((p) => (
              <div className="card hot" key={p.id}>
                <div className="row">
                  <strong>{p.business_name}</strong>
                  <span className="pill pill-hot">sample requested</span>
                </div>
                <p className="small">Ship to: {p.sample_address ?? "no address captured — check thread"}</p>
                <form action={markSampleShipped}>
                  <input type="hidden" name="partner_id" value={p.id} />
                  <button className="primary">Mark shipped</button>
                </form>
              </div>
            ))}
        </>
      )}

      {escalations.length > 0 && <h2>⚠️ Escalations — Howard drafted nothing, these are yours</h2>}
      {escalations.map((r) => (
        <div className="card hot" key={r.id}>
          <div className="row">
            <strong>{r.ph_partners.business_name}</strong>
            <span className="pill pill-hot">{r.attention_reason}</span>
          </div>
          {r.ph_partners.email && <p className="small muted">{r.ph_partners.email}</p>}
          <ReplyContext partnerId={r.partner_id} />
          <form action={dismissAttention}>
            <input type="hidden" name="id" value={r.id} />
            <button>Handled — dismiss</button>
          </form>
        </div>
      ))}

      {otherAttention.length > 0 && <h2>Replies needing review</h2>}
      {otherAttention.map((r) => (
        <DraftCard key={r.id} row={r} hot />
      ))}

      {draftRows.length > 0 && <h2>Drafts pending approval</h2>}
      {draftRows.map((r) => (
        <DraftCard key={r.id} row={r} />
      ))}
    </>
  );
}

async function ReplyContext({ partnerId }: { partnerId: string }) {
  const { data } = await db()
    .from("ph_outreach")
    .select("reply_snippet")
    .eq("partner_id", partnerId)
    .not("reply_snippet", "is", null)
    .order("replied_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.reply_snippet) return null;
  return <div className="email-body small">{data.reply_snippet}</div>;
}

function DraftCard({ row, hot }: { row: Row; hot?: boolean }) {
  const p = row.ph_partners;
  return (
    <div className={`card ${hot ? "hot" : "warm"}`}>
      <div className="row">
        <strong>{p.business_name}</strong>
        <span className="pill pill-stage">
          {p.city ? `${p.city}, ${p.state}` : p.state ?? ""} · {p.segment}
          {p.fit_score != null ? ` · score ${p.fit_score}` : ""}
        </span>
        {row.is_reply_draft && <span className="pill pill-stage">reply</span>}
        {row.attention_reason && <span className="pill pill-hot">{row.attention_reason}</span>}
      </div>
      <p className="small muted">
        To: {p.email ?? "—"} ({p.email_status}) · touch #{row.touch_number}
      </p>
      {row.reply_snippet && (
        <>
          <p className="small muted">Their reply:</p>
          <div className="email-body small">{row.reply_snippet}</div>
        </>
      )}
      <form action={approveDraft}>
        <input type="hidden" name="id" value={row.id} />
        <input type="text" name="subject" defaultValue={row.subject} />
        <textarea name="body" defaultValue={row.body} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" type="submit">
            Approve
          </button>
          <button className="danger" formAction={rejectDraft} type="submit">
            Reject
          </button>
        </div>
      </form>
    </div>
  );
}
