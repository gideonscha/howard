import { NextRequest, NextResponse } from "next/server";
import { verifyUnsubscribeToken } from "@/lib/tokens";
import { db } from "@/lib/supabase";

async function unsubscribe(token: string): Promise<NextResponse> {
  const email = verifyUnsubscribeToken(token);
  if (!email) return new NextResponse("Invalid link", { status: 400 });

  const supa = db();
  // Unique index on lower(email) makes a repeat click a no-op.
  const { error } = await supa.from("ph_suppression").insert({ email, reason: "unsubscribe link" });
  if (error && !error.message.includes("duplicate")) {
    console.error("unsubscribe insert failed:", error.message);
  }
  const { logActivity } = await import("@/lib/activity");
  await logActivity("suppression", `unsubscribe click — ${email}`);
  const { data: partners } = await supa
    .from("ph_partners")
    .select("id")
    .ilike("email", email);
  const ids = (partners ?? []).map((p) => p.id);
  if (ids.length) {
    await supa
      .from("ph_partners")
      .update({ stage: "declined", updated_at: new Date().toISOString() })
      .in("id", ids);
    await supa
      .from("ph_outreach")
      .update({ status: "rejected", attention_reason: "unsubscribed" })
      .in("partner_id", ids)
      .in("status", ["draft", "approved"]);
  }

  return new NextResponse(
    `<html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center">
      <h2>You're unsubscribed.</h2>
      <p>${email} won't hear from us again. Sorry for the interruption.</p>
    </body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  );
}

// GET = human clicking the link; POST = RFC 8058 one-click (List-Unsubscribe-Post).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return unsubscribe((await params).token);
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return unsubscribe((await params).token);
}
