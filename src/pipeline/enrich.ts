import { scrapeMarkdown } from "@/lib/firecrawl";
import { structured, classifyModel } from "@/lib/anthropic";
import { verifyEmail } from "@/lib/verify-email";
import { db } from "@/lib/supabase";
import { domainOf, emailDomainAligned } from "@/lib/contact-guard";
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

// Concurrency-limited worker pool: `concurrency` workers pull from a shared
// queue until items are exhausted or the deadline passes. Enrichment is
// per-partner-independent and almost entirely I/O wait (Firecrawl scrape +
// Anthropic classify + ZeroBounce verify), so running many concurrently is the
// single biggest throughput lever — sequential processing was the bottleneck
// that let discovery outrun enrichment ~10x. Returns how many items ran.
async function processPool<T>(
  items: T[],
  concurrency: number,
  deadline: number,
  worker: (item: T) => Promise<void>
): Promise<number> {
  let idx = 0;
  let processed = 0;
  async function run() {
    while (idx < items.length && Date.now() < deadline) {
      const item = items[idx++];
      await worker(item);
      processed++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) || 1 }, run));
  return processed;
}

// Re-verify 'unverified' emails (ZeroBounce was rate-limited/unavailable when
// first enriched). verifyEmail now throws on a no-status/error response, so a
// transient failure is re-tried next tick instead of sticking as 'unverified'.
export async function reverifyPass(limit = 200, concurrency = 10): Promise<number> {
  const supa = db();
  let recheckedSendable = 0;
  // Only rows we have NOT already re-checked. Without this filter the pass
  // re-sends every 'unverified' row to ZeroBounce every tick forever — the main
  // driver of runaway credit usage. Each row gets exactly one re-verify attempt.
  const { data: rows } = await supa
    .from("ph_partners")
    .select("id,email,email_status,enrichment")
    .in("stage", ["qualified", "queued"])
    .eq("email_status", "unverified")
    .not("email", "is", null)
    .or("enrichment->>reverified.is.null,enrichment->>reverified.neq.done")
    .limit(limit);
  const deadline = Date.now() + 90_000;
  await processPool(rows ?? [], concurrency, deadline, async (row) => {
    const enrichment = { ...((row.enrichment as Record<string, unknown>) ?? {}), reverified: "done" };
    try {
      const status = await verifyEmail(row.email as string);
      if (status === "verified" || status === "catch_all") recheckedSendable++;
      await supa
        .from("ph_partners")
        .update({ email_status: status, enrichment, updated_at: new Date().toISOString() })
        .eq("id", row.id);
    } catch (e) {
      console.warn(`reverify: failed for ${row.email}: ${(e as Error).message}`);
      // Mark attempted even on failure, so a persistently-unresolvable address
      // (dead/obscure domain ZeroBounce can't reach) isn't retried every tick.
      try {
        await supa
          .from("ph_partners")
          .update({ enrichment, updated_at: new Date().toISOString() })
          .eq("id", row.id);
      } catch {
        /* best-effort */
      }
    }
  });
  return recheckedSendable;
}

// Fetch one partner's site, classify fit, find + verify the email. Mutates the
// row to stage='qualified'|'declined'. Returns true if qualified. Self-contained
// so it can run inside the concurrent pool.
async function enrichOne(partner: Partner): Promise<boolean> {
  const supa = db();
  let siteContent = "";
  if (partner.website) {
    try {
      // 6k chars (~1.5k tokens) is plenty to judge fit + pull a contact detail;
      // the old 20k just inflated input tokens on every partner.
      siteContent = (await scrapeMarkdown(partner.website)).slice(0, 6000);
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
    model: classifyModel(),
    maxTokens: 512,
  });

  // Domain-alignment guard: a scraped/LLM-extracted address is only trusted if
  // it matches the business's own domain (or is a public mailbox). A foreign
  // corporate domain (another business's inbox on this page) is dropped so the
  // ladder below can hunt for the right one.
  let email = (c.contact_email ?? partner.email)?.trim().toLowerCase() || null;
  if (email && !emailDomainAligned(email, partner.website)) {
    console.log(`enrich: dropped misaligned email ${email} for ${partner.business_name} (site ${partner.website ?? "none"})`);
    email = null;
  }
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
        if (hit && emailDomainAligned(hit.email, partner.website)) {
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

  // Cross-record uniqueness: if this email already sits on a DIFFERENT business
  // (different website domain), it's a shared/parent inbox being stamped onto
  // unrelated records — flag for manual review, don't trust it.
  let sharedConflict = false;
  if (email) {
    const { data: dupes } = await supa
      .from("ph_partners")
      .select("id,website")
      .eq("email", email)
      .neq("id", partner.id);
    const mine = domainOf(partner.website);
    sharedConflict = (dupes ?? []).some((d) => domainOf(d.website) !== mine);
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
        // invalid/missing email or a shared cross-business inbox → manual touch
        // via contact form / phone, not an automated send.
        needs_manual_contact: !email || emailStatus === "invalid" || sharedConflict,
        ...(sharedConflict ? { shared_email_conflict: true } : {}),
      },
      stage: c.qualified ? "qualified" : "declined",
      notes: c.qualified ? partner.notes : c.disqualify_reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", partner.id);
  return c.qualified;
}

// Drain the sourced backlog: classify fit + find/verify email, concurrently.
export async function runEnrich(
  limit = 300,
  concurrency = 10
): Promise<{
  processed: number;
  qualified: number;
  healAttempted: number;
  healed: number;
  recheckedSendable: number;
}> {
  const supa = db();

  // Re-verify pass runs FIRST so the rows that hit a transient ZeroBounce
  // failure get another shot before we spend the cycle on fresh scrapes.
  const recheckedSendable = await reverifyPass(Math.max(limit, 200), concurrency);

  const { data: partners, error } = await supa
    .from("ph_partners")
    .select("*")
    .eq("stage", "sourced")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const { setProgress } = await import("@/lib/progress");
  // Generous deadline + concurrency does the heavy lifting; the deadline only
  // exists as a backstop so a slow batch can't blow the 800s cron budget.
  // Unprocessed sourced rows simply resume next tick.
  const mainDeadline = Date.now() + 7 * 60_000;
  let qualified = 0;
  let done = 0;
  const total = partners?.length ?? 0;
  const processed = await processPool(
    (partners ?? []) as Partner[],
    concurrency,
    mainDeadline,
    async (partner) => {
      try {
        if (await enrichOne(partner)) qualified++;
      } catch (e) {
        console.error(`enrich: failed for ${partner.id}: ${(e as Error).message}`);
      }
      done++;
      if (done % concurrency === 0) await setProgress(`enrich: ${done}/${total}`);
    }
  );

  // Email-hunt healing pass: email-less qualified/queued partners get the (now
  // domain-guarded) contact hunt retried, concurrently. Freshly-quarantined
  // rows are ordered to the FRONT so recovery targets them first.
  let healAttempted = 0;
  let healed = 0;
  const healDeadline = Date.now() + 2 * 60_000;
  const { data: emailless } = await supa
    .from("ph_partners")
    .select("id,website,business_name,enrichment")
    .in("stage", ["qualified", "queued"])
    .is("email", null)
    .not("website", "is", null)
    .or("enrichment->>email_hunted.is.null,enrichment->>email_hunted.neq.true")
    .order("enrichment->>quarantined_at", { ascending: false, nullsFirst: false })
    .limit(Math.max(limit, 200));
  healAttempted = await processPool(emailless ?? [], concurrency, healDeadline, async (row) => {
    try {
      const { findEmailOnSite } = await import("@/lib/email-hunt");
      let found = await findEmailOnSite(row.website as string);
      let foundName: string | null = null;
      let foundSource: string | null = found ? "contact_page" : null;
      if (!found) {
        const { hunterDomainSearch } = await import("@/lib/hunter");
        const hit = await hunterDomainSearch(row.website as string).catch(() => null);
        if (hit && emailDomainAligned(hit.email, row.website as string)) {
          found = hit.email;
          foundName = hit.contactName;
          foundSource = "hunter";
        }
      }
      const status = found ? await verifyEmail(found).catch(() => "unverified" as const) : "unverified";
      if (found && (status === "verified" || status === "catch_all")) healed++;
      await supa
        .from("ph_partners")
        .update({
          ...(found ? { email: found, email_status: status } : {}),
          ...(foundName ? { contact_name: foundName } : {}),
          enrichment: {
            ...((row.enrichment as Record<string, unknown>) ?? {}),
            email_hunted: true,
            ...(found && (status === "verified" || status === "catch_all") ? { needs_manual_contact: false } : {}),
            ...(foundSource ? { email_source: foundSource } : {}),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    } catch (e) {
      console.warn(`enrich(emailhunt): failed for ${row.business_name}: ${(e as Error).message}`);
    }
  });

  return { processed, qualified, healAttempted, healed, recheckedSendable };
}
