import { randomUUID } from "crypto";
import { structured } from "@/lib/anthropic";
import { getConfig, HOWARD_PERSONA, offerBlock, offerConfig } from "@/lib/config";
import { requireEnv } from "@/lib/env";
import { clickToken } from "@/lib/tokens";
import { db } from "@/lib/supabase";
import { Partner } from "./types";

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    opener: { type: "string" },
    closer: { type: "string" },
  },
  required: ["subject", "opener", "closer"],
  additionalProperties: false,
};

export function howardSystemPrompt(usedSubjects: string[]): string {
  return `${HOWARD_PERSONA}

Return JSON with exactly three fields — subject, opener, closer — and nothing else. The system assembles the full email as: your opener, then a FIXED offer block (which you do NOT write), then your closer followed by a link, then the signature.

subject:
- Short, specific to THIS business — reference their name or the detail you were given.
- Must be distinct. Do NOT reuse any of these already-used subjects: ${usedSubjects.length ? usedSubjects.map((s) => `"${s}"`).join(", ") : "(none yet)"}.

opener (2–4 sentences):
- Open with the ONE specific detail about their business — show you actually looked.
- For vet clinics, lead with the families they comfort when it's time to say goodbye; for memorial businesses, the families they already serve.
- Then transition warmly to: you'd like to offer something for those families.
- CRITICAL: do NOT state any numbers, gift, commission, discount, or terms — the system inserts the exact offer immediately after your opener. If you mention terms you will contradict the real offer.

closer (1 short sentence):
- Invite them to see what their families would receive, leading directly into a link.
- Do NOT write any URL — the system appends the link after your sentence.

Tone: warm, brief, human, plain text. No marketing-speak, no exclamation points, no "I hope this finds you well". Vary sentence structure between emails — do not reuse a template skeleton.`;
}

// Organisation key: collapse multi-location chains to one outreach. Same
// website domain (or same non-public email domain, or same exact email) = one org.
const PUBLIC_MAIL = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com",
  "icloud.com", "me.com", "msn.com", "live.com", "comcast.net",
]);

function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}

function orgKey(p: { website: string | null; email: string | null; id: string }): string {
  const wd = domainOf(p.website);
  if (wd) return `w:${wd}`;
  const ed = p.email?.split("@")[1]?.toLowerCase();
  if (ed && !PUBLIC_MAIL.has(ed)) return `d:${ed}`;
  if (p.email) return `e:${p.email.toLowerCase()}`;
  return `id:${p.id}`;
}

// Personalised first touch per partner → ph_outreach status='draft'. Never sends.
// Opener is personalised; the offer block is fixed and identical; one outreach
// per organisation (chains deduped); the CTA link is wrapped for click tracking.
export async function runDraft(limit = 5): Promise<{ drafted: number }> {
  const supa = db();
  const config = await getConfig();
  const offer = offerConfig(config);
  const block = offerBlock(offer);
  const base = requireEnv("PUBLIC_BASE_URL").replace(/\/$/, "");

  // Org keys already taken by any existing outreach (so chains/repeats are skipped).
  const { data: outreached } = await supa
    .from("ph_outreach")
    .select("ph_partners(id,website,email)");
  const takenOrgKeys = new Set<string>();
  type JoinRow = { ph_partners: { id: string; website: string | null; email: string | null } | { id: string; website: string | null; email: string | null }[] | null };
  for (const row of (outreached ?? []) as unknown as JoinRow[]) {
    const j = row.ph_partners;
    const partner = Array.isArray(j) ? j[0] : j;
    if (partner) takenOrgKeys.add(orgKey(partner));
  }

  // Candidates: top of the scored queue, verified email, no own outreach.
  const { data: partners, error } = await supa
    .from("ph_partners")
    .select("*, ph_outreach(id)")
    .eq("stage", "queued")
    .eq("email_status", "verified")
    .order("fit_score", { ascending: false })
    .limit(limit * 6);
  if (error) throw error;

  const seenOrgKeys = new Set<string>(takenOrgKeys);
  const fresh: Partner[] = [];
  for (const p of (partners ?? []) as (Partner & { ph_outreach: { id: string }[] })[]) {
    if (p.ph_outreach.length > 0) continue;
    const key = orgKey(p);
    if (seenOrgKeys.has(key)) continue; // one outreach per organisation
    seenOrgKeys.add(key);
    fresh.push(p);
    if (fresh.length >= limit) break;
  }

  const { setProgress } = await import("@/lib/progress");
  const usedSubjects: string[] = [];
  let drafted = 0;
  let i = 0;
  for (const p of fresh) {
    i++;
    await setProgress(`draft: ${i}/${fresh.length} — ${p.business_name}`);
    const detail =
      (p.enrichment?.business_detail as string | undefined) ??
      `${p.business_name} serves pet families in ${p.city ?? "their area"}, ${p.state ?? ""}`;
    try {
      const d = await structured<{ subject: string; opener: string; closer: string }>({
        system: howardSystemPrompt(usedSubjects),
        user: `Write the first outreach email.
Business: ${p.business_name}
Location: ${p.city ?? "?"}, ${p.state ?? "?"}
Segment: ${p.segment} / ${p.subtype ?? "?"}
Contact name (use first name in greeting if present, else no name): ${p.contact_name ?? "unknown"}
Specific detail to open with: ${detail}`,
        schema: DRAFT_SCHEMA,
        maxTokens: 700,
      });

      // Guarantee subject uniqueness within the batch.
      let subject = d.subject.trim();
      if (usedSubjects.some((s) => s.toLowerCase() === subject.toLowerCase())) {
        subject = `${subject} (${p.city ?? p.state ?? "your area"})`;
      }

      // Pre-generate the id so we can embed the wrapped CTA in one write.
      const id = randomUUID();
      const wrapped = `${base}/c/${clickToken(id)}`;
      const body = `${d.opener.trim()}\n\n${block}\n\n${d.closer.trim()} ${wrapped}\n\nHoward\nMagic Portraits`;

      await supa.from("ph_outreach").insert({
        id,
        partner_id: p.id,
        touch_number: 1,
        subject,
        body,
        status: "draft",
      });
      usedSubjects.push(subject);
      drafted++;
    } catch (e) {
      console.error(`draft: failed for ${p.id}: ${(e as Error).message}`);
    }
  }
  return { drafted };
}
