import { NextRequest, NextResponse } from "next/server";
import { verifyUnsubscribeToken } from "@/lib/tokens";
import { db } from "@/lib/supabase";

// Actually suppress + decline. Only ever called from POST (a real human
// confirming, or a mail client's RFC 8058 one-click), never from a bare GET —
// email security gateways auto-fetch (GET) every link in a message, including
// the unsubscribe link, and were falsely unsubscribing partners seconds after
// send. GET now shows a confirmation page instead.
async function applyUnsubscribe(token: string): Promise<NextResponse> {
  const email = verifyUnsubscribeToken(token);
  if (!email) return new NextResponse("Invalid link", { status: 400 });

  const supa = db();
  const { error } = await supa.from("ph_suppression").insert({ email, reason: "unsubscribe link" });
  if (error && !error.message.includes("duplicate")) {
    console.error("unsubscribe insert failed:", error.message);
  }
  const { logActivity } = await import("@/lib/activity");
  await logActivity("suppression", `unsubscribe confirmed — ${email}`);
  const { data: partners } = await supa.from("ph_partners").select("id").ilike("email", email);
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

// GET = a link being opened (could be a human OR an automated security scanner).
// Show a confirmation page with a button that POSTs — do NOT suppress here.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!verifyUnsubscribeToken(token)) return new NextResponse("Invalid link", { status: 400 });
  return new NextResponse(
    `<html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center">
      <h2>Unsubscribe?</h2>
      <p>Click below and you won't hear from us again.</p>
      <form method="POST" action="">
        <button type="submit" style="font-size:16px;padding:10px 20px;cursor:pointer">Unsubscribe me</button>
      </form>
    </body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  );
}

// POST = the confirm button above, or a mail client's RFC 8058 one-click
// (List-Unsubscribe-Post). This actually unsubscribes.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return applyUnsubscribe((await params).token);
}
