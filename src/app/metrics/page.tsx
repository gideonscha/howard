import { db, fetchAll } from "@/lib/supabase";
import { PLACES_LOCATION_COUNT } from "@/pipeline/discover/places";
import { sendingEnabled } from "@/lib/env";
import { resolveDailyCap } from "@/pipeline/send";
import { AutoRefresh } from "@/app/run/refresh";
import { ActivityFeed } from "@/app/activity/feed";

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
] as const;

const EMAIL_COLORS: Record<string, string> = {
  verified: "#1a7f4b",
  catch_all: "#2563eb",
  risky: "#b8860b",
  invalid: "#b42318",
  unverified: "#9ca3af",
};

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

// Pacific-time hour bucket key ("YYYY-MM-DD HH") — sends/window are PT-based, so
// the hourly chart reads naturally in the timezone we operate in.
function ptHourKey(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hh = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hh}`;
}

// The last n hourly buckets (PT), oldest→newest. Stepping back in 1h UTC
// increments yields consecutive PT hours (PT is a whole-hour offset).
function lastNHours(n: number): { key: string; label: string }[] {
  const now = Date.now();
  const out: { key: string; label: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = ptHourKey(new Date(now - i * 3_600_000));
    out.push({ key, label: key.slice(11) });
  }
  return out;
}

// Inline SVG hourly bar chart: outgoing vs incoming email per hour (PT).
function HourlyComms({ buckets }: { buckets: { label: string; out: number; inc: number }[] }) {
  const w = 700;
  const h = 120;
  const max = Math.max(1, ...buckets.flatMap((b) => [b.out, b.inc]));
  const groupW = w / buckets.length;
  const barW = Math.max(2, groupW / 3);
  const series: { key: "out" | "inc"; color: string; label: string }[] = [
    { key: "out", color: "#8a5a2b", label: "sent" },
    { key: "inc", color: "#1a7f4b", label: "received" },
  ];
  return (
    <svg viewBox={`0 0 ${w} ${h + 18}`} style={{ width: "100%", height: "auto" }}>
      {buckets.map((b, i) =>
        series.map((s, j) => {
          const v = b[s.key];
          const bh = (v / max) * h;
          return (
            <rect
              key={`${i}-${j}`}
              x={i * groupW + j * barW + 2}
              y={h - bh}
              width={barW - 1}
              height={bh}
              rx={1.5}
              fill={s.color}
            >
              <title>{`${b.label}:00 PT — ${b.out} sent, ${b.inc} received`}</title>
            </rect>
          );
        })
      )}
      {buckets.map((b, i) =>
        i % 3 === 0 ? (
          <text key={i} x={i * groupW + groupW / 2} y={h + 14} fontSize="9" fill="#6b7280" textAnchor="middle">
            {b.label}
          </text>
        ) : null
      )}
    </svg>
  );
}

// Inline SVG bar chart: one group per day, up to two series.
function Bars({
  days,
  series,
}: {
  days: string[];
  series: { label: string; color: string; values: number[] }[];
}) {
  const w = 700;
  const h = 120;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const groupW = w / days.length;
  const barW = Math.max(2, groupW / (series.length + 1));
  return (
    <svg viewBox={`0 0 ${w} ${h + 18}`} style={{ width: "100%", height: "auto" }}>
      {days.map((d, i) =>
        series.map((s, j) => {
          const v = s.values[i];
          const bh = (v / max) * h;
          return (
            <rect
              key={`${d}-${j}`}
              x={i * groupW + j * barW + 2}
              y={h - bh}
              width={barW - 1}
              height={bh}
              rx={1.5}
              fill={s.color}
            >
              <title>{`${d}: ${v} ${s.label}`}</title>
            </rect>
          );
        })
      )}
      {days.map((d, i) =>
        i % 2 === 0 ? (
          <text key={d} x={i * groupW + groupW / 2} y={h + 14} fontSize="9" fill="#6b7280" textAnchor="middle">
            {d.slice(5)}
          </text>
        ) : null
      )}
    </svg>
  );
}

function Donut({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = Math.max(
    1,
    parts.reduce((s, p) => s + p.value, 0)
  );
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg viewBox="0 0 120 120" style={{ width: 140, height: 140 }}>
      {parts.map((p) => {
        const frac = p.value / total;
        const seg = (
          <circle
            key={p.label}
            cx="60"
            cy="60"
            r={r}
            fill="none"
            stroke={p.color}
            strokeWidth="16"
            strokeDasharray={`${frac * c} ${c}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 60 60)"
          >
            <title>{`${p.label}: ${p.value}`}</title>
          </circle>
        );
        offset += frac * c;
        return seg;
      })}
      <text x="60" y="64" textAnchor="middle" fontSize="18" fontWeight="700" fill="#1f2328">
        {total}
      </text>
    </svg>
  );
}

function HBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0" }}>
      <span className="small" style={{ width: 110, textAlign: "right" }}>{label}</span>
      <div style={{ flex: 1, background: "#f0ede6", borderRadius: 4, height: 18 }}>
        <div
          style={{
            width: `${max ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0}%`,
            background: color,
            height: 18,
            borderRadius: 4,
          }}
        />
      </div>
      <span className="small" style={{ width: 36 }}>{value}</span>
    </div>
  );
}

// Tile-grid US map: [col, row] per state — geographic-ish, equal weight.
const STATE_GRID: Record<string, [number, number]> = {
  AK: [0, 0], ME: [11, 0],
  VT: [10, 1], NH: [11, 1],
  WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2], IL: [6, 2], WI: [7, 2], MI: [8, 2], NY: [9, 2], RI: [10, 2], MA: [11, 2],
  OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3], PA: [8, 3], NJ: [9, 3], CT: [10, 3],
  CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4], VA: [8, 4], MD: [9, 4], DE: [10, 4],
  AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5], DC: [9, 5],
  OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6],
  HI: [0, 7], TX: [4, 7], FL: [8, 7],
};

function UsTileMap({
  byState,
}: {
  byState: Map<string, { live: number; verified: number }>;
}) {
  const cell = 46;
  const pad = 3;
  const cols = 12;
  const rows = 8;
  const max = Math.max(1, ...[...byState.values()].map((v) => v.live));
  return (
    <svg
      viewBox={`0 0 ${cols * cell} ${rows * cell}`}
      style={{ width: "100%", height: "auto", maxWidth: 640 }}
    >
      {Object.entries(STATE_GRID).map(([abbr, [c, r]]) => {
        const v = byState.get(abbr) ?? { live: 0, verified: 0 };
        const intensity = v.live === 0 ? 0 : 0.25 + 0.75 * (v.live / max);
        return (
          <g key={abbr} transform={`translate(${c * cell}, ${r * cell})`}>
            <rect
              x={pad}
              y={pad}
              width={cell - pad * 2}
              height={cell - pad * 2}
              rx={5}
              fill={v.live === 0 ? "#f0ede6" : `rgba(138,90,68,${intensity.toFixed(2)})`}
              stroke="#e5e2db"
            >
              <title>{`${abbr}: ${v.live} prospects, ${v.verified} verified`}</title>
            </rect>
            <text
              x={cell / 2}
              y={cell / 2 - 3}
              textAnchor="middle"
              fontSize="11"
              fontWeight="600"
              fill={intensity > 0.55 ? "#fff" : "#1f2328"}
            >
              {abbr}
            </text>
            {v.live > 0 && (
              <text
                x={cell / 2}
                y={cell / 2 + 11}
                textAnchor="middle"
                fontSize="10"
                fill={intensity > 0.55 ? "#fff" : "#6b7280"}
              >
                {v.live}
                {v.verified > 0 ? ` ✓${v.verified}` : ""}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default async function MetricsPage() {
  const supa = db();
  const since14 = new Date();
  since14.setUTCDate(since14.getUTCDate() - 13);
  since14.setUTCHours(0, 0, 0, 0);
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);

  const [
    partners,
    { data: sendLog },
    { data: referrals },
    { count: suppression },
    { count: draftsPending },
    { count: needsAttention },
    { data: targetRow },
    { data: placesCursorRow },
    { data: inboundActivity },
  ] = await Promise.all([
    fetchAll<{
      stage: string; segment: string; email_status: string; fit_score: number | null;
      source: string; sample_status: string; created_at: string; state: string | null;
    }>(() =>
      supa.from("ph_partners").select("stage,segment,email_status,fit_score,source,sample_status,created_at,state")
    ),
    supa.from("ph_send_log").select("dry_run,sent_at").gte("sent_at", since14.toISOString()),
    supa.from("ph_referrals").select("orders_count,revenue"),
    supa.from("ph_suppression").select("id", { count: "exact", head: true }),
    supa.from("ph_outreach").select("id", { count: "exact", head: true }).eq("status", "draft"),
    supa.from("ph_outreach").select("id", { count: "exact", head: true }).eq("needs_attention", true),
    supa.from("ph_config").select("value").eq("key", "prospect_target").maybeSingle(),
    supa.from("ph_config").select("value").eq("key", "_places_cursor").maybeSingle(),
    supa
      .from("ph_activity")
      .select("at")
      .eq("kind", "inbound")
      .gte("at", new Date(Date.now() - 26 * 3_600_000).toISOString()),
  ]);

  const ps = partners ?? [];
  const target = Number(targetRow?.value) || 2000;

  const inWarehouse = (p: { stage: string; email_status: string; fit_score: number | null }) =>
    ["qualified", "queued", "contacted", "replied", "negotiating", "signed", "live"].includes(p.stage) &&
    (p.email_status === "verified" || p.email_status === "catch_all" || (p.fit_score ?? 0) >= 60);
  const warehouse = ps.filter(inWarehouse).length;
  const warehouseMemorial = ps.filter((p) => inWarehouse(p) && p.segment === "memorial").length;
  const warehouseVet = ps.filter((p) => inWarehouse(p) && p.segment === "vet").length;

  const stageCounts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<string, number>;
  for (const p of ps) if (p.stage in stageCounts) stageCounts[p.stage]++;
  const stageMax = Math.max(1, ...Object.values(stageCounts));

  const emailParts = Object.entries(EMAIL_COLORS).map(([label, color]) => ({
    label,
    color,
    value: ps.filter((p) => p.email_status === label).length,
  }));

  const sourceCounts = new Map<string, number>();
  for (const p of ps) {
    const key = (p.source ?? "unknown").split(":")[0];
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }
  const sourceMax = Math.max(1, ...sourceCounts.values());

  const byState = new Map<string, { live: number; verified: number }>();
  for (const p of ps) {
    if (!p.state || p.stage === "declined") continue;
    const s = byState.get(p.state) ?? { live: 0, verified: 0 };
    s.live++;
    if (p.email_status === "verified") s.verified++;
    byState.set(p.state, s);
  }
  let sweptLocs = 0;
  try {
    const cursor = JSON.parse(placesCursorRow?.value ?? "{}");
    sweptLocs = cursor.done ? PLACES_LOCATION_COUNT : Number(cursor.locIdx) || 0;
  } catch {
    /* no cursor yet */
  }

  const days = lastNDays(14);
  const partnersPerDay = days.map((d) => ps.filter((p) => (p.created_at ?? "").slice(0, 10) === d).length);
  const sentPerDay = days.map(
    (d) => (sendLog ?? []).filter((l) => !l.dry_run && l.sent_at.slice(0, 10) === d).length
  );
  const dryPerDay = days.map(
    (d) => (sendLog ?? []).filter((l) => l.dry_run && l.sent_at.slice(0, 10) === d).length
  );

  // Hourly email comms (last 24h, PT): outgoing sends vs incoming replies.
  const hours = lastNHours(24);
  const outByHour = new Map<string, number>();
  for (const l of sendLog ?? []) {
    if (l.dry_run) continue;
    const k = ptHourKey(new Date(l.sent_at));
    outByHour.set(k, (outByHour.get(k) ?? 0) + 1);
  }
  const incByHour = new Map<string, number>();
  for (const a of (inboundActivity ?? []) as { at: string }[]) {
    const k = ptHourKey(new Date(a.at));
    incByHour.set(k, (incByHour.get(k) ?? 0) + 1);
  }
  const commsBuckets = hours.map((hr) => ({
    label: hr.label,
    out: outByHour.get(hr.key) ?? 0,
    inc: incByHour.get(hr.key) ?? 0,
  }));

  const sentToday = (sendLog ?? []).filter((l) => !l.dry_run && l.sent_at >= midnight.toISOString()).length;
  const replies = ps.filter((p) => ["replied", "negotiating", "signed", "live"].includes(p.stage)).length;
  const contacted = ps.filter((p) =>
    ["contacted", "replied", "negotiating", "signed", "live"].includes(p.stage)
  ).length;
  const samples = ps.filter((p) => !["none", "offered"].includes(p.sample_status)).length;
  const orders = (referrals ?? []).reduce((s, r) => s + Number(r.orders_count), 0);
  const revenue = (referrals ?? []).reduce((s, r) => s + Number(r.revenue), 0);
  const pct = Math.min(100, Math.round((warehouse / target) * 100));
  const cap = await resolveDailyCap();

  return (
    <>
      <AutoRefresh seconds={5} />
      <h1>Metrics</h1>

      <ActivityFeed limit={12} compact />

      <div className="card">
        <div className="row">
          <strong>Prospect warehouse</strong>
          <span className="pill pill-stage">{warehouse} / {target} ({pct}%)</span>
          <span className={sendingEnabled() ? "pill pill-live" : "pill pill-dark"}>
            {sendingEnabled() ? "SENDING LIVE" : "SENDING OFF"}
          </span>
        </div>
        <div style={{ background: "#f0ede6", borderRadius: 6, height: 22, marginTop: 8 }}>
          <div
            style={{
              width: `${Math.max(pct, 1)}%`,
              background: "linear-gradient(90deg,#8a5a44,#b07a5e)",
              height: 22,
              borderRadius: 6,
            }}
          />
        </div>
        <p className="small muted" style={{ marginBottom: 0, marginTop: 8 }}>
          by segment: <strong>{warehouseMemorial}</strong> memorial · <strong>{warehouseVet}</strong> vet
        </p>
      </div>

      <div className="statgrid">
        <div className="stat"><div className="v">{ps.length}</div><div className="l">partners total</div></div>
        <div className="stat">
          <div className="v" style={{ color: "#1a7f4b" }}>
            {ps.filter((p) => (p.email_status === "verified" || p.email_status === "catch_all") && p.stage !== "declined").length}
          </div>
          <div className="l">verified emails (sendable)</div>
        </div>
        <div className="stat"><div className="v">{draftsPending ?? 0}</div><div className="l">drafts awaiting approval</div></div>
        <div className="stat"><div className="v">{needsAttention ?? 0}</div><div className="l">need attention</div></div>
        <div className="stat"><div className="v">{sentToday}/{cap}</div><div className="l">sent today / cap</div></div>
        <div className="stat"><div className="v">{contacted}</div><div className="l">contacted</div></div>
        <div className="stat"><div className="v">{replies}</div><div className="l">replied+</div></div>
        <div className="stat"><div className="v">{samples}</div><div className="l">sample requests</div></div>
        <div className="stat"><div className="v">{suppression ?? 0}</div><div className="l">suppressed</div></div>
        <div className="stat"><div className="v">{orders}</div><div className="l">attributed orders</div></div>
        <div className="stat"><div className="v">${revenue.toFixed(0)}</div><div className="l">attributed revenue</div></div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Email comms by hour (24h, PT)</h2>
          <span className="small" style={{ color: "#8a5a2b" }}>■ sent</span>
          <span className="small" style={{ color: "#1a7f4b" }}>■ received</span>
        </div>
        <HourlyComms buckets={commsBuckets} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Pipeline funnel</h2>
        {STAGES.map((s) => (
          <HBar key={s} label={s} value={stageCounts[s]} max={stageMax} color="#8a5a44" />
        ))}
        <HBar
          label="declined"
          value={ps.filter((p) => p.stage === "declined").length}
          max={stageMax}
          color="#c9c4ba"
        />
        <p className="small muted" style={{ marginBottom: 0 }}>
          sourced/qualified are transient — the hourly cycle promotes them to queued within
          minutes. declined = filtered out (non-US, suppliers, unsubscribes).
        </p>
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ marginTop: 0 }}>Coverage map</h2>
          <span className="pill pill-stage">
            Places sweep: {sweptLocs}/{PLACES_LOCATION_COUNT} metros
          </span>
        </div>
        <UsTileMap byState={byState} />
        <p className="small muted" style={{ marginBottom: 0 }}>
          Shade = live prospects per state · ✓n = verified emails. Hover a state for details.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>New partners per day (14d)</h2>
        <Bars days={days} series={[{ label: "added", color: "#8a5a44", values: partnersPerDay }]} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Sends per day (14d)</h2>
        <Bars
          days={days}
          series={[
            { label: "sent", color: "#1a7f4b", values: sentPerDay },
            { label: "dry-run", color: "#9ca3af", values: dryPerDay },
          ]}
        />
        <p className="small muted">
          <span style={{ color: "#1a7f4b" }}>■</span> real sends&nbsp;&nbsp;
          <span style={{ color: "#9ca3af" }}>■</span> dry-runs (kill-switch off)
        </p>
      </div>

      <div className="row" style={{ alignItems: "stretch" }}>
        <div className="card" style={{ flex: 1, minWidth: 220 }}>
          <h2 style={{ marginTop: 0 }}>Email quality</h2>
          <div className="row">
            <Donut parts={emailParts} />
            <div>
              {emailParts.map((p) => (
                <p key={p.label} className="small" style={{ margin: "2px 0" }}>
                  <span style={{ color: p.color }}>■</span> {p.label}: {p.value}
                </p>
              ))}
            </div>
          </div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 220 }}>
          <h2 style={{ marginTop: 0 }}>By source</h2>
          {[...sourceCounts.entries()].map(([s, v]) => (
            <HBar key={s} label={s} value={v} max={sourceMax} color="#5b7a8a" />
          ))}
        </div>
      </div>
    </>
  );
}
