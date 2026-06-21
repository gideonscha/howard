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

  if (outreachId) {
    try {
      const supa = db();
      const { data: o } = await supa
        .from("ph_outreach")
        .select("partner_id")
        .eq("id", outreachId)
        .maybeSingle();
      await supa.from("ph_clicks").insert({
        partner_id: o?.partner_id ?? null,
        outreach_id: outreachId,
        target_url: target,
      });
    } catch (e) {
      console.error(`click log failed: ${(e as Error).message}`);
    }
  }

  return NextResponse.redirect(target, 302);
}
