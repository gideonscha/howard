import { NextRequest, NextResponse } from "next/server";
import { runSend } from "@/pipeline/send";
import { runFollowup } from "@/pipeline/followup";
import { runAttribute } from "@/pipeline/attribute";

export const maxDuration = 300;

// Single hourly dispatcher (Pro plan). Sends are paced naturally: the daily
// cap is shared across hourly invocations, so approved mail trickles out
// rather than blasting at midnight. Attribution runs once a day (06:00 UTC).
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const results: Record<string, unknown> = {};
  try {
    results.send = await runSend();
  } catch (e) {
    results.send = { error: (e as Error).message };
  }
  try {
    results.followup = await runFollowup();
  } catch (e) {
    results.followup = { error: (e as Error).message };
  }
  if (new Date().getUTCHours() === 6) {
    try {
      results.attribute = await runAttribute();
    } catch (e) {
      results.attribute = { error: (e as Error).message };
    }
  }
  return NextResponse.json({ ok: true, results });
}
