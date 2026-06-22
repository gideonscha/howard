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
    detail: { type: "string" },
    cta: { type: "string" },
  },
  required: ["subject", "detail", "cta"],
  additionalProperties: false,
};

// Role/generic local-parts that are NOT a person's name.
const ROLE_LOCALPARTS = new Set([
  "info", "contact", "contactus", "office", "hello", "admin", "sales", "team",
  "support", "care", "mail", "help", "service", "services", "general", "inquiries",
  "enquiries", "booking", "bookings", "accounts", "billing", "reception", "frontdesk",
  "pets", "memorials", "aftercare", "noreply", "no-reply", "email", "mailbox",
  "owner", "staff", "hi", "petcremation", "cremation",
]);
const NAME_TITLES = new Set(["dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms."]);

// Common given names — used to tell a real personal email (tiffany@) apart from
// an initial+surname or business inbox (jbullock@, heckartfh@, apetcremation@).
// A name is only trusted from an email when its first token is in this set, so
// we never mistake a business string for a person.
const COMMON_FIRST_NAMES = new Set([
  "aaron","adam","adrian","alan","albert","alex","alexa","alexis","alice","alicia","allen","amanda","amber","amy","andrea","andrew","andy","angela","ann","anna","anne","anthony","april","arthur","ashley","austin",
  "barbara","becky","ben","benjamin","beth","betty","beverly","bill","billy","bob","bobby","bonnie","brad","bradley","brandon","brenda","brian","brittany","bruce","bryan",
  "carl","carla","carlos","carol","carolyn","carrie","catherine","cathy","chad","charles","charlie","cheryl","chris","christian","christina","christine","christopher","cindy","claire","clara","cody","colette","colleen","connie","craig","crystal","curtis","cy","cynthia",
  "dale","dan","dana","daniel","danielle","danny","darlene","darren","dave","david","dawn","dean","debbie","deborah","debra","denice","denise","dennis","derek","diana","diane","don","donald","donna","doris","dorothy","doug","douglas","duane","dustin",
  "earl","ed","eddie","edward","edwin","eileen","elaine","eleanor","elizabeth","ellen","emily","emma","eric","erica","erik","erin","ernest","ethan","eugene","evan","evelyn",
  "frances","francis","frank","fred","gabriel","gail","gary","gene","george","gerald","gina","glenn","gloria","gordon","grace","greg","gregory",
  "hannah","harold","harry","heather","helen","henry","herbert","holly","howard","hugh",
  "ian","irene","isaac","jack","jackie","jacob","jake","james","jamie","jan","jane","janet","janice","jared","jason","jay","jean","jeff","jeffrey","jenna","jennifer","jenny","jeremy","jerry","jesse","jessica","jill","jim","jimmy","joan","joann","joanne","jodi","joe","joel","john","johnny","jon","jonathan","jordan","joseph","josh","joshua","joyce","juan","judith","judy","julia","julie","justin",
  "karen","karl","kate","katherine","kathleen","kathryn","kathy","katie","kayla","kaylee","keith","kelly","ken","kenneth","kevin","kim","kimberly","kris","kristen","kristin","kristina","kyle",
  "larry","laura","lauren","laurie","lawrence","lee","leon","leonard","leslie","linda","lindsay","lisa","lloyd","logan","lois","loretta","lori","louis","louise","lucas","lucy","luke","lydia","lynn",
  "marc","marcia","margaret","maria","marie","marilyn","mark","marsha","martha","martin","marvin","mary","mason","matt","matthew","maureen","megan","melanie","melissa","melvin","michael","michelle","mike","mildred","molly","monica","morgan",
  "nancy","naomi","natalie","nathan","neil","nicholas","nick","nicole","noah","nora","norman",
  "olivia","oscar","owen","pam","pamela","pat","patricia","patrick","patty","paul","paula","peggy","peter","philip","phillip","phyllis",
  "rachel","ralph","randy","ray","raymond","rebecca","regina","renee","rhonda","richard","rick","rita","rob","robert","roberta","robin","rodney","roger","ron","ronald","rose","roy","russell","ruth","ryan",
  "sally","sam","samantha","samuel","sandra","sandy","sara","sarah","scott","sean","seth","shane","shannon","sharon","shawn","sheila","shelly","sherry","shirley","stacey","stacy","stan","stanley","stephanie","stephen","steve","steven","sue","susan","suzanne",
  "tami","tammy","tanya","tara","ted","teresa","terri","terry","theresa","thomas","tiffany","tim","timothy","tina","todd","tom","tony","tracy","travis","trevor","troy",
  "valerie","vanessa","vera","vernon","veronica","vicki","vickie","victor","victoria","vincent","virginia","wade","walter","wanda","warren","wayne","wendy","wesley","william","willie","yolanda","zachary",
]);

function firstNameOf(name: string | null): string | null {
  if (!name) return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < parts.length && NAME_TITLES.has(parts[i].toLowerCase())) i++;
  const tok = parts[i];
  if (!tok || !/^[A-Za-z][A-Za-z'-]+$/.test(tok)) return null;
  return tok[0].toUpperCase() + tok.slice(1).toLowerCase();
}

// A name from the email's local-part — only when the first token is a known
// given name (so jbullock@/heckartfh@/apetcremation@ are NOT treated as people).
function nameFromEmail(email: string | null): string | null {
  if (!email) return null;
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (!local || ROLE_LOCALPARTS.has(local)) return null;
  const tok = local.split(/[._+-]/)[0];
  if (!tok || !COMMON_FIRST_NAMES.has(tok)) return null;
  return tok[0].toUpperCase() + tok.slice(1);
}

// Greeting is resolved in CODE (not model-written) so a name can never
// contradict the actual inbox. The email's owner is who actually reads it, so
// when a known personal email name differs from the researched contact name
// (e.g. contact "Aaron" but the address is tiffany@…), greet the inbox owner.
// Nickname/prefix overlaps (dan@ for "Daniel") are treated as the same person.
export function resolveGreeting(contactName: string | null, email: string | null): string {
  const cFirst = firstNameOf(contactName);
  const eFirst = nameFromEmail(email);
  if (cFirst && eFirst) {
    const a = cFirst.toLowerCase();
    const b = eFirst.toLowerCase();
    const related = a === b || a.startsWith(b) || b.startsWith(a);
    return related ? `Hi ${cFirst},` : `Hi ${eFirst},`;
  }
  if (cFirst) return `Hi ${cFirst},`;
  if (eFirst) return `Hi ${eFirst},`;
  return "Hello,";
}

export function howardSystemPrompt(usedSubjects: string[]): string {
  return `${HOWARD_PERSONA}

You are writing the personal parts of a SHORT outreach email — the kind a real person dashes off, not a marketing template. Return JSON with exactly three fields — subject, detail, cta — and nothing else. The system assembles the email: a greeting it writes itself, then your detail sentence followed by a FIXED "who we are" line (you do NOT write that), then a FIXED offer block, then a demo link, then your cta, then the signature. Do NOT write a greeting — the system adds it.

subject:
- Clear over clever. Say what it is. Good pattern: "A free memorial gift for {business}'s families" (adapt naturally to the business).
- Must be distinct. Do NOT reuse any of these already-used subjects: ${usedSubjects.length ? usedSubjects.map((s) => `"${s}"`).join(", ") : "(none yet)"}.

detail — EXACTLY ONE sentence:
- The ONE or TWO most distinctive details about THIS business — not an inventory. If they offer five things, pick the single most telling one (the on-site cremation, the 365-day grief program, "since 1983"). Short and specific beats comprehensive; never list more than two things.
- Write ONLY this one observation. Do NOT introduce Magic Portraits, do NOT mention any gift/commission/discount, do NOT add a "here's why I'm writing" hand-off. The system appends the "who we are" line and the offer immediately after.
- End with a period.

cta — the closing call to action (ONE short sentence):
- A warm, natural invitation to REPLY. The reply is the next step — any sign of interest ("yes", "tell me more", "sounds good", "interested") is the right response, and a real person reads it.
- Do NOT require any specific phrase or keyword. Do NOT name the codes or details (those come later once they reply). Do NOT include any URL or "click"/"order"/"claim".
- Light and low-friction, e.g. "If that sounds worth a look, just reply and let me know — I'll get you set up." Vary the wording across emails so two recipients don't see the same line.

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
      const d = await structured<{ subject: string; detail: string; cta: string }>({
        system: howardSystemPrompt(usedSubjects),
        user: `Write the top of the outreach email (no greeting — the system adds it).
Business: ${p.business_name}
Location: ${p.city ?? "?"}, ${p.state ?? "?"}
Segment: ${p.segment} / ${p.subtype ?? "?"}
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
        `${resolveGreeting(p.contact_name, p.email)}\n\n` +
        `${d.detail.trim()} ${WHO_WE_ARE}\n\n` +
        `${block}\n\n` +
        `Here's exactly what a family would receive — take a look [here](${wrapped}).\n\n` +
        `${d.cta.trim()}\n\n` +
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
