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

  const { setProgress } = await import("@/lib/progress");
  let qualified = 0;
  let i = 0;
  for (const partner of (partners ?? []) as Partner[]) {
    i++;
    await setProgress(`enrich: ${i}/${partners?.length ?? 0} — ${partner.business_name}`);
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
          "You qualify US pet-related businesses as referral partners for a premium pet memorial portrait product. The partner must SERVE GRIEVING PET FAMILIES DIRECTLY at the end-of-life moment.\n" +
          "- MEMORIAL segment qualifies if: pet crematory, pet cemetery, aftercare provider, or in-home euthanasia service.\n" +
          "- VET segment qualifies ONLY if the clinic offers end-of-life services — euthanasia, pet hospice/palliative care, cremation/aftercare, or memorial services. Set offers_aftercare=true when they handle cremation/aftercare (in-house or coordinated). A GENERAL veterinary practice with NO end-of-life or aftercare emphasis is qualified=false (we don't want every vet, only those at the memorial moment).\n" +
          "Mark qualified=false for: out of business, not pet-related, human-only services, outside the US, and suppliers/manufacturers/vendors that sell TO aftercare businesses rather than to families (urn wholesalers, keepsake manufacturers, body-bag suppliers, software, marketing services, association staff). Be factual.",
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

      let email = (c.contact_email ?? partner.email)?.trim().toLowerCase() || null;
      let huntedName: string | null = null;
      let emailSource: string | null = email ? "site" : null;
      // Email ladder: site-claimed → contact-page hunt (free) → Hunter (1 credit).
      if (!email && partner.website) {
        const { findEmailOnSite } = await import("@/lib/email-hunt");
        email = await findEmailOnSite(partner.website);
        if (email) emailSource = "contact_page";
        if (!email) {
          try {
            const { hunterDomainSearch } = await import("@/lib/hunter");
            const hit = await hunterDomainSearch(partner.website);
            if (hit) {
              email = hit.email;
              huntedName = hit.contactName;
              emailSource = "hunter";
            }
          } catch (e) {
            console.warn(`enrich(hunter): ${partner.business_name}: ${(e as Error).message}`);
          }
        }
      }
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
          contact_name: huntedName ?? c.contact_name ?? partner.contact_name,
          offers_aftercare: c.offers_aftercare,
          sells_memorial_products: c.sells_memorial_products,
          enrichment: {
            business_detail: c.business_detail,
            disqualify_reason: c.disqualify_reason,
            email_source: emailSource,
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
  // Email-hunt healing pass: qualified partners with no email get the
  // contact-page hunt retried (covers rows enriched before the hunter
  // existed). Found addresses go straight to verification.
  const { data: emailless } = await supa
    .from("ph_partners")
    .select("id,website,business_name,enrichment")
    .in("stage", ["qualified", "queued"])
    .is("email", null)
    .not("website", "is", null)
    .or("enrichment->>email_hunted.is.null,enrichment->>email_hunted.neq.true")
    .limit(limit);
  for (const row of emailless ?? []) {
    try {
      const { findEmailOnSite } = await import("@/lib/email-hunt");
      let found = await findEmailOnSite(row.website as string);
      let foundName: string | null = null;
      let foundSource: string | null = found ? "contact_page" : null;
      if (!found) {
        const { hunterDomainSearch } = await import("@/lib/hunter");
        const hit = await hunterDomainSearch(row.website as string).catch(() => null);
        if (hit) {
          found = hit.email;
          foundName = hit.contactName;
          foundSource = "hunter";
        }
      }
      const status = found ? await verifyEmail(found).catch(() => "unverified" as const) : "unverified";
      await supa
        .from("ph_partners")
        .update({
          ...(found ? { email: found, email_status: status } : {}),
          ...(foundName ? { contact_name: foundName } : {}),
          enrichment: {
            ...((row.enrichment as Record<string, unknown>) ?? {}),
            email_hunted: true,
            ...(foundSource ? { email_source: foundSource } : {}),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    } catch (e) {
      console.warn(`enrich(emailhunt): failed for ${row.business_name}: ${(e as Error).message}`);
    }
  }

  // Re-verify pass: partners that got through classification while email
  // verification was unavailable (e.g. missing API key) stay 'unverified';
  // pick them up here so a later run can heal them.
  const { data: unverified } = await supa
    .from("ph_partners")
    .select("id,email")
    .in("stage", ["qualified", "queued"])
    .eq("email_status", "unverified")
    .not("email", "is", null)
    .limit(limit);
  for (const row of unverified ?? []) {
    try {
      const status = await verifyEmail(row.email as string);
      await supa
        .from("ph_partners")
        .update({ email_status: status, updated_at: new Date().toISOString() })
        .eq("id", row.id);
    } catch (e) {
      console.warn(`enrich(reverify): failed for ${row.email}: ${(e as Error).message}`);
    }
  }

  return { processed: partners?.length ?? 0, qualified };
}
