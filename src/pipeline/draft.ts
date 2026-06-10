import { structured } from "@/lib/anthropic";
import { configuredTerms, getConfig } from "@/lib/config";
import { optionalEnv } from "@/lib/env";
import { db } from "@/lib/supabase";
import { Partner } from "./types";

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
};

export function howardSystemPrompt(terms: string[]): string {
  const termsBlock = terms.length
    ? `Configured offer terms you MAY state concretely:\n${terms.join("\n")}`
    : `NO offer terms are configured. HARD RULE: never state a specific commission percentage, donation amount, or what the sample set contains. Speak only in structure: "a referral commission", "a donation to a rescue of your choice", "a sample set of Star in Heaven tiles".`;

  return `You are Howard, partner outreach for Magic Portraits — premium AI pet portraits printed on photo tiles. Our memorial theme "Star in Heaven" helps families honor a pet they've lost.

You write to US pet memorial businesses (crematoriums, pet cemeteries, aftercare providers, in-home euthanasia vets) proposing a gift program: a memorial gift they can give every family, at no cost to them, with their name on it.

Tone rules (memorial context — non-negotiable):
- Lead with serving THEIR families, never "we want your customers".
- Warm, brief, human. No marketing-speak, no exclamation points, no "I hope this finds you well".
- Plain text only. 90–140 words. Sign as "Howard" with "Magic Portraits" beneath.
- Open with the one specific detail about their business — show you actually looked.

Offer structure:
- For memorial businesses: a gift for the families they already serve; commission OR donation-to-a-rescue framing, their choice.
- For vets: a compassionate aftercare gesture.
- Crematoriums may also be offered a wholesale/bundle option, mentioned lightly.

CTA rules:
- PRIMARY CTA: the self-demo — "upload a photo of your own pet and see what your families would receive; takes 60 seconds, free" with this link: ${optionalEnv("SELF_DEMO_URL", "[self-demo link]")}
- Secondary beat (one sentence): a free physical sample set of Star in Heaven tiles is available if they'd like to see and hold the real thing.
- Never ask for a call or meeting in the first touch.

${termsBlock}

Do NOT include any signature footer beyond "Howard\\nMagic Portraits" — the system appends the legal footer automatically.`;
}

// Personalised first touch per queued partner → ph_outreach status='draft'. Never sends.
export async function runDraft(limit = 5): Promise<{ drafted: number }> {
  const supa = db();
  const config = await getConfig();
  const terms = configuredTerms(config);

  // Top of the scored queue, verified email, no existing outreach.
  const { data: partners, error } = await supa
    .from("ph_partners")
    .select("*, ph_outreach(id)")
    .eq("stage", "queued")
    .eq("email_status", "verified")
    .order("fit_score", { ascending: false })
    .limit(limit * 3);
  if (error) throw error;

  const fresh = ((partners ?? []) as (Partner & { ph_outreach: { id: string }[] })[])
    .filter((p) => p.ph_outreach.length === 0)
    .slice(0, limit);

  const { setProgress } = await import("@/lib/progress");
  let drafted = 0;
  let i = 0;
  for (const p of fresh) {
    i++;
    await setProgress(`draft: ${i}/${fresh.length} — ${p.business_name}`);
    const detail =
      (p.enrichment?.business_detail as string | undefined) ??
      `${p.business_name} serves pet families in ${p.city ?? "their area"}, ${p.state ?? ""}`;
    try {
      const d = await structured<{ subject: string; body: string }>({
        system: howardSystemPrompt(terms),
        user: `Write the first outreach email.
Business: ${p.business_name}
Location: ${p.city ?? "?"}, ${p.state ?? "?"}
Segment: ${p.segment} / ${p.subtype ?? "?"}
Contact name (use first name in greeting if present, else no name): ${p.contact_name ?? "unknown"}
Sells memorial products already: ${p.sells_memorial_products ? "yes" : "no/unknown"}
Chain/network: ${p.is_chain ? "yes — multiple locations" : "no"}
Specific detail to open with: ${detail}`,
        schema: DRAFT_SCHEMA,
        maxTokens: 1024,
      });
      await supa.from("ph_outreach").insert({
        partner_id: p.id,
        touch_number: 1,
        subject: d.subject,
        body: d.body,
        status: "draft",
      });
      drafted++;
    } catch (e) {
      console.error(`draft: failed for ${p.id}: ${(e as Error).message}`);
    }
  }
  return { drafted };
}
