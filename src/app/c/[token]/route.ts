import { NextRequest, NextResponse } from "next/server";
import { verifyClickToken } from "@/lib/tokens";
import { getConfig, offerConfig } from "@/lib/config";
import { db } from "@/lib/supabase";

// Wrapped CTA: log the click (sent → clicked funnel), then 302 to /memorial.
// A bad/forged token still redirects (never break a family's click) but logs nothing.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const target = offerConfig(await getConfig()).familyCtaUrl;
  const outreachId = verifyClickToken(token);

  let partnerId: string | null = null;
  if (outreachId) {
    try {
      const supa = db();
      const { data: o } = await supa
        .from("ph_outreach")
        .select("partner_id")
        .eq("id", outreachId)
        .maybeSingle();
      partnerId = o?.partner_id ?? null;
      await supa.from("ph_clicks").insert({
        partner_id: partnerId,
        outreach_id: outreachId,
        target_url: target,
      });
    } catch (e) {
      console.error(`click log failed: ${(e as Error).message}`);
    }
  }

  // Best-effort link→order attribution: tag the destination with UTM params so
  // the storefront/analytics can carry the partner reference through to checkout.
  // (Tie-through is only as good as what the store captures — see ATTRIBUTION.md.)
  let dest = target;
  if (outreachId) {
    try {
      const url = new URL(target);
      url.searchParams.set("utm_source", "howard");
      url.searchParams.set("utm_medium", "partner");
      url.searchParams.set("utm_campaign", "star-in-heaven");
      if (partnerId) url.searchParams.set("ref", partnerId);
      url.searchParams.set("howard_oid", outreachId);
      dest = url.toString();
    } catch {
      // malformed familyCtaUrl — fall back to the bare target
    }
  }

  return NextResponse.redirect(dest, 302);
}
