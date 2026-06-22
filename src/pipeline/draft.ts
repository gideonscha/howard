import { randomUUID } from "crypto";
import { structured } from "@/lib/anthropic";
import { getConfig, HOWARD_PERSONA, offerBlock, offerConfig, WHO_WE_ARE } from "@/lib/config";
import { publicBaseUrl } from "@/lib/env";
import { clickToken } from "@/lib/tokens";
import { db } from "@/lib/supabase";
import { Partner } from "./types";

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    greeting: { type: "string" },
    detail: { type: "string" },
    cta: { type: "string" },
  },
  required: ["subject", "greeting", "detail", "cta"],
  additionalProperties: false,
};

export function howardSystemPrompt(usedSubjects: string[]): string {
  return `${HOWARD_PERSONA}

You are writing the personal parts of a SHORT outreach email — the kind a real person dashes off, not a marketing template. Return JSON with exactly four fields — subject, greeting, detail, cta — and nothing else. The system assembles the email: your greeting, then your detail sentence followed by a FIXED "who we are" line (you do NOT write that), then a FIXED offer block, then a demo link on its own line, then your cta, then the signature.

subject:
- Clear over clever. Say what it is. Good pattern: "A free memorial gift for {business}'s families" (adapt naturally to the business).
- Must be distinct. Do NOT reuse any of these already-used subjects: ${usedSubjects.length ? usedSubjects.map((s) => `"${s}"`).join(", ") : "(none yet)"}.

greeting (one line, ends with a comma):
- If a real person's name is known, greet by first name — "Hi Nan,". Two owners → "Hi Rick and Shea,".
- If no contact name is given but the email address clearly embeds a person's name (e.g. "rick@…" → "Hi Rick,", "j.smith@…" → "Hi J,"/"Hi John," only if unambiguous), use it.
- Otherwise (generic/role inbox like info@ or allcounty@, or no name at all) use a warm "Hello,".
- ALWAYS output a greeting.

detail — EXACTLY ONE sentence:
- The ONE or TWO most distinctive details about THIS business — not an inventory. If they offer five things, pick the single most telling one (the on-site cremation, the 365-day grief program, "since 1983"). Short and specific beats comprehensive; never list more than two things.
- Write ONLY this one observation. Do NOT introduce Magic Portraits, do NOT mention any gift/commission/discount, do NOT add a "here's why I'm writing" hand-off. The system appends the "who we are" line and the offer immediately after.
- End with a period.

cta — the closing call to action (one or two short sentences):
- A REPLY-based next step, not a click. The owner replies to engage.
- Must name BOTH things they get: their two free sample sets AND their families' discount code.
- Must contain the exact quoted phrase: reply "send me the samples" — keep those words verbatim so it's an unmistakable trigger; vary all the wording around it so two recipients don't see the same sentence.
- Low-friction and warm. Do NOT include any URL or "click"/"order"/"claim" — the reply IS the action. Example shape (vary it): \`Interested? Just reply "send me the samples" and I'll get your two free sets and your families' discount code on the way.\`

Tone: warm but never gushing, brief, plain text, sounds like one person wrote it. A busy owner skims — earn the next line. No exclamation points, no "I hope this finds you well". Vary structure across emails; never reuse a sentence skeleton.`;
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
export async function runDraft(
  limit = 5
): Promise<{ drafted: number; candidates: number; eligible: number; firstError?: string }> {
  const supa = db();
  const config = await getConfig();
  const offer = offerConfig(config);
  const block = offerBlock(offer);
  const base = publicBaseUrl();

  // Partner IDs that already have any outreach (so we draft each org once).
  const { data: outreachRows } = await supa.from("ph_outreach").select("partner_id");
  const partnersWithOutreach = new Set((outreachRows ?? []).map((r) => r.partner_id));

  // Org keys already taken by existing outreach (collapse chains/repeats).
  const takenOrgKeys = new Set<string>();
  if (partnersWithOutreach.size > 0) {
    const { data: takenPartners } = await supa
      .from("ph_partners")
      .select("id,website,email")
      .in("id", [...partnersWithOutreach]);
    for (const tp of takenPartners ?? []) takenOrgKeys.add(orgKey(tp));
  }

  // Candidates: top of the scored queue, verified email.
  const { data: partners, error } = await supa
    .from("ph_partners")
    .select("*")
    .eq("stage", "queued")
    .eq("email_status", "verified")
    .order("fit_score", { ascending: false, nullsFirst: false })
    .limit(limit * 6);
  if (error) throw error;
  console.log(`draft: ${partners?.length ?? 0} candidates, ${partnersWithOutreach.size} already have outreach`);

  const seenOrgKeys = new Set<string>(takenOrgKeys);
  const fresh: Partner[] = [];
  for (const p of (partners ?? []) as Partner[]) {
    if (partnersWithOutreach.has(p.id)) continue; // already drafted/contacted
    const key = orgKey(p);
    if (seenOrgKeys.has(key)) continue; // one outreach per organisation
    seenOrgKeys.add(key);
    fresh.push(p);
    if (fresh.length >= limit) break;
  }

  const { setProgress } = await import("@/lib/progress");
  // Soft deadline so a large batch can't exceed the function budget — it
  // drafts what it can, the rest resume next cycle (each partner drafted once).
  const deadline = Date.now() + 6 * 60_000;
  const usedSubjects: string[] = [];
  let drafted = 0;
  let firstError: string | undefined;
  let i = 0;
  for (const p of fresh) {
    if (Date.now() > deadline) {
      console.log(`draft: time-boxed at ${i}/${fresh.length}; resuming next cycle`);
      break;
    }
    i++;
    await setProgress(`draft: ${i}/${fresh.length} — ${p.business_name}`);
    const detail =
      (p.enrichment?.business_detail as string | undefined) ??
      `${p.business_name} serves pet families in ${p.city ?? "their area"}, ${p.state ?? ""}`;
    try {
      const d = await structured<{ subject: string; greeting: string; detail: string; cta: string }>({
        system: howardSystemPrompt(usedSubjects),
        user: `Write the top of the outreach email.
Business: ${p.business_name}
Location: ${p.city ?? "?"}, ${p.state ?? "?"}
Segment: ${p.segment} / ${p.subtype ?? "?"}
Contact person (for the greeting — a real name, or "none"): ${p.contact_name ?? "none"}
Email address (you MAY extract a first name from this for the greeting if no contact person): ${p.email ?? "none"}
ONE researched detail to open with: ${detail}`,
        schema: DRAFT_SCHEMA,
        maxTokens: 600,
      });

      // Guarantee subject uniqueness within the batch.
      let subject = d.subject.trim();
      if (usedSubjects.some((s) => s.toLowerCase() === subject.toLowerCase())) {
        subject = `${subject} (${p.city ?? p.state ?? "your area"})`;
      }

      // Pre-generate the id so we can embed the wrapped CTA in one write.
      const id = randomUUID();
      const wrapped = `${base}/c/${clickToken(id)}`;
      // Guarantee the reply trigger phrase is present even if the model drifts.
      let cta = d.cta.trim();
      if (!/send me the samples/i.test(cta)) {
        cta = `Interested? Just reply "send me the samples" and I'll get your two free sets and your families' discount code on the way.`;
      }

      const body =
        `${d.greeting.trim()}\n\n` +
        `${d.detail.trim()} ${WHO_WE_ARE}\n\n` +
        `${block}\n\n` +
        `Here's exactly what a family would receive: ${wrapped}\n\n` +
        `${cta}\n\n` +
        `Howard / Magic Portraits`;

      const { error: insErr } = await supa.from("ph_outreach").insert({
        id,
        partner_id: p.id,
        touch_number: 1,
        subject,
        body,
        status: "draft",
      });
      if (insErr) throw new Error(`insert: ${insErr.message}`);
      usedSubjects.push(subject);
      drafted++;
    } catch (e) {
      if (!firstError) firstError = `${p.business_name}: ${(e as Error).message}`;
      console.error(`draft: failed for ${p.id}: ${(e as Error).message}`);
    }
  }
  return { drafted, candidates: partners?.length ?? 0, eligible: fresh.length, firstError };
}
