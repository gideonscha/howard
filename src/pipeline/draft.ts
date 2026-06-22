import { randomUUID } from "crypto";
import { structured } from "@/lib/anthropic";
import { getConfig, HOWARD_PERSONA, offerBlock, offerConfig } from "@/lib/config";
import { publicBaseUrl } from "@/lib/env";
import { clickToken } from "@/lib/tokens";
import { db } from "@/lib/supabase";
import { Partner } from "./types";

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    greeting: { type: "string" },
    intro: { type: "string" },
  },
  required: ["subject", "greeting", "intro"],
  additionalProperties: false,
};

export function howardSystemPrompt(usedSubjects: string[]): string {
  return `${HOWARD_PERSONA}

You are writing the top of a SHORT outreach email — the kind a real person dashes off, not a marketing template. Return JSON with exactly three fields — subject, greeting, intro — and nothing else. The system then appends a FIXED offer block (three bullets you do NOT write), the demo link, a sign-off line, and the signature. So the recipient reads: your greeting, your intro (ending in a colon), the three offer bullets, the link, the close, the signature.

subject:
- Clear over clever. Say what it is. Good pattern: "A free memorial gift for {business}'s families" (adapt naturally to the business).
- Must be distinct. Do NOT reuse any of these already-used subjects: ${usedSubjects.length ? usedSubjects.map((s) => `"${s}"`).join(", ") : "(none yet)"}.

greeting (one line, ends with a comma):
- If a real person's name is known, greet by first name — "Hi Nan,". Two owners → "Hi Rick and Shea,".
- If no contact name is given but the email address clearly embeds a person's name (e.g. "rick@…" → "Hi Rick,", "j.smith@…" → "Hi J,"/"Hi John," only if unambiguous), use it.
- Otherwise (generic/role inbox like info@ or allcounty@, or no name at all) use a warm "Hello,".
- ALWAYS output a greeting.

intro — EXACTLY TWO sentences, no more:
- Sentence 1: ONE specific, researched detail about THIS business to show it isn't mass mail (the viewing room, "since 1996", their Texas locations). ONE detail — not a paragraph of praise. Specificity, not flattery.
- Sentence 2: who we are, in one plain line: "I'm with Magic Portraits — we make hand-finished portraits of pets who've passed, printed on premium tiles".
- STOP THERE. Do NOT add a third hand-off sentence. In particular NEVER write "Here's why I'm reaching out", "Here's why I'm writing", "There's something here…", or any generic transition — the offer block that follows opens with its own lead-in ("Here's the idea, and it costs you nothing:"), so a connective sentence is redundant and reads as a template across emails.
- Do NOT state any numbers, gift contents, commission, or discount — the system inserts the exact offer right after.

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
      const d = await structured<{ subject: string; greeting: string; intro: string }>({
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
      const body =
        `${d.greeting.trim()}\n\n` +
        `${d.intro.trim()}\n\n` +
        `${block}\n\n` +
        `Here's exactly what a family would receive: ${wrapped}\n\n` +
        `If it's a fit, I'll get your two sets shipped out.\n\n` +
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
