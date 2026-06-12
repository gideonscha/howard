import Link from "next/link";
import { db } from "@/lib/supabase";
import { Partner } from "@/pipeline/types";

export const dynamic = "force-dynamic";

const STAGES = [
  "sourced",
  "qualified",
  "queued",
  "contacted",
  "replied",
  "negotiating",
  "signed",
  "live",
  "declined",
] as const;

export default async function Pipeline({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; segment?: string; state?: string; source?: string; page?: string }>;
}) {
  const params = await searchParams;
  const supa = db();
  const PAGE_SIZE = 50;
  const page = Math.max(1, Number(params.page) || 1);

  const { data: all } = await supa
    .from("ph_partners")
    .select("id,stage,segment,state,source");
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<string, number>;
  for (const p of all ?? []) counts[p.stage] = (counts[p.stage] ?? 0) + 1;

  let q = supa
    .from("ph_partners")
    .select("*", { count: "exact" })
    .order("fit_score", { ascending: false, nullsFirst: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (params.stage) q = q.eq("stage", params.stage);
  if (params.segment) q = q.eq("segment", params.segment);
  if (params.state) q = q.eq("state", params.state.toUpperCase());
  if (params.source) q = q.ilike("source", `${params.source}%`);
  const { data: partners, count: totalCount } = await q;
  const total = totalCount ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const qs = (over: Record<string, string | undefined>) => {
    // Filter changes reset to page 1 unless a page is explicitly given.
    const merged = { ...params, page: undefined, ...over };
    const s = Object.entries(merged)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join("&");
    return s ? `?${s}` : "";
  };

  return (
    <>
      <h1>Pipeline</h1>
      <div className="statgrid">
        {STAGES.map((s) => (
          <Link key={s} href={`/pipeline${qs({ stage: s })}`} style={{ textDecoration: "none", color: "inherit" }}>
            <div className="stat">
              <div className="v">{counts[s]}</div>
              <div className="l">{s}</div>
            </div>
          </Link>
        ))}
      </div>
      <div className="filterbar">
        <Link href="/pipeline" className={!params.stage && !params.segment ? "active" : ""}>
          all
        </Link>
        <Link href={`/pipeline${qs({ segment: "memorial" })}`} className={params.segment === "memorial" ? "active" : ""}>
          memorial
        </Link>
        <Link href={`/pipeline${qs({ segment: "vet" })}`} className={params.segment === "vet" ? "active" : ""}>
          vet
        </Link>
        {["iaopcc", "gateway", "lapoflove"].map((src) => (
          <Link key={src} href={`/pipeline${qs({ source: src })}`} className={params.source === src ? "active" : ""}>
            {src}
          </Link>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th>Business</th>
            <th className="hide-mobile">Location</th>
            <th>Score</th>
            <th>Stage</th>
            <th className="hide-mobile">Email</th>
          </tr>
        </thead>
        <tbody>
          {((partners ?? []) as Partner[]).map((p) => (
            <tr key={p.id}>
              <td>
                <Link href={`/pipeline/${p.id}`}>{p.business_name}</Link>
                {p.is_chain && <span className="small muted"> · chain</span>}
              </td>
              <td className="hide-mobile">
                {p.city ? `${p.city}, ` : ""}
                {p.state ?? ""}
              </td>
              <td>{p.fit_score ?? "—"}</td>
              <td>
                <span className="pill pill-stage">{p.stage}</span>
              </td>
              <td className="hide-mobile small">
                {p.email ?? "—"} {p.email && <span className="muted">({p.email_status})</span>}
              </td>
            </tr>
          ))}
          {(partners ?? []).length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No partners match. Run discover to fill the pipeline.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {total > PAGE_SIZE && (
        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          {page > 1 ? (
            <Link href={`/pipeline${qs({ page: String(page - 1) })}`}>← Previous</Link>
          ) : (
            <span className="muted">← Previous</span>
          )}
          <span className="small muted">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} · page {page}/{lastPage}
          </span>
          {page < lastPage ? (
            <Link href={`/pipeline${qs({ page: String(page + 1) })}`}>Next →</Link>
          ) : (
            <span className="muted">Next →</span>
          )}
        </div>
      )}
    </>
  );
}
