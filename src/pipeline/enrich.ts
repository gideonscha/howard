import { scrapeMarkdown } from "@/lib/firecrawl";
import { structured } from "@/lib/anthropic";
import { verifyEmail } from "@/lib/verify-email";
import { db } from "@/lib/supabase";
import { Partner } from "./types";

interface Classification {
  offers_aftercare: boolean;
  sells_memorial_products: boolean;
  contact_email: string | null;
  contact_name: string | null;
  business_detail: string;
  qualified: boolean;
  disqualify_reason: string | null;
}

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    offers_aftercare: { type: "boolean" },
    sells_memorial_products: { type: "boolean" },
    contact_email: { type: ["string", "null"] },
    contact_name: { type: ["string", "null"] },
    business_detail: {
      type: "string",
      description:
        "One specific, concrete detail about this business usable to personalize an outreach email (a service they highlight, how long they've served their area, something distinctive).",
    },
    qualified: { type: "boolean" },
    disqualify_reason: { type: ["string", "null"] },
  },
  required: [
    "offers_aftercare",
    "sells_memorial_products",
    "contact_email",
    "contact_name",
    "business_detail",
    "qualified",
    "disqualify_reason",
  ],
  additionalProperties: false,
};

// Fetch the partner's site, classify fit, verify the email. → stage='qualified'
export async function runEnrich(limit = 10): Promise<{ processed: number; qualified: number }> {
  const supa = db();
  const { data: partners, error } = await supa
    .from("ph_partners")
    .select("*")
    .eq("stage", "sourced")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  let qualified = 0;
  for (const partner of (partners ?? []) as Partner[]) {
    try {
      let siteContent = "";
      if (partner.website) {
        try {
          siteContent = (await scrapeMarkdown(partner.website)).slice(0, 20000);
        } catch {
          siteContent = "";
        }
      }

      const c = await structured<Classification>({
        system:
          "You qualify US pet-related businesses as referral partners for a premium pet memorial portrait product. Be factual; only mark qualified=false for clear disqualifiers (out of business, not pet-related, human-only services, outside the US).",
        user: `Business: ${partner.business_name} (${partner.city ?? "?"}, ${partner.state ?? "?"})
Segment guess: ${partner.segment} / ${partner.subtype ?? "?"}
Known email: ${partner.email ?? "none"}
Website content (markdown, may be empty):
---
${siteContent || "(no website content available)"}
---
Classify this business.`,
        schema: CLASSIFY_SCHEMA,
      });

      const email = (c.contact_email ?? partner.email)?.trim().toLowerCase() || null;
      let emailStatus: Partner["email_status"] = "unverified";
      if (email) {
        try {
          emailStatus = await verifyEmail(email);
        } catch (e) {
          console.warn(`enrich: verification failed for ${email}: ${(e as Error).message}`);
        }
      }

      await supa
        .from("ph_partners")
        .update({
          email,
          email_status: emailStatus,
          contact_name: c.contact_name ?? partner.contact_name,
          offers_aftercare: c.offers_aftercare,
          sells_memorial_products: c.sells_memorial_products,
          enrichment: {
            business_detail: c.business_detail,
            disqualify_reason: c.disqualify_reason,
            // invalid email → manual touch via contact form / phone, not deletion
            needs_manual_contact: !email || emailStatus === "invalid",
          },
          stage: c.qualified ? "qualified" : "declined",
          notes: c.qualified ? partner.notes : c.disqualify_reason,
          updated_at: new Date().toISOString(),
        })
        .eq("id", partner.id);
      if (c.qualified) qualified++;
    } catch (e) {
      console.error(`enrich: failed for ${partner.id}: ${(e as Error).message}`);
    }
  }
  return { processed: partners?.length ?? 0, qualified };
}
