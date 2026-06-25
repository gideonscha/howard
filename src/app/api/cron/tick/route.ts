import { NextRequest, NextResponse } from "next/server";
import { runAutoApprove } from "@/pipeline/approve";
import { runSend } from "@/pipeline/send";
import { runFollowup } from "@/pipeline/followup";
import { runAttribute } from "@/pipeline/attribute";
import { runAutopilot } from "@/pipeline/autopilot";

export const maxDuration = 800;

// Single hourly dispatcher (Pro plan). Order: auto-approve the day's warm-up
// batch, then send (cap-bound, drip-paced, time-sensitive), then the prospecting
// autopilot (discover→enrich→score→draft top-up), then daily attribution at
// 06:00 UTC. Sends pace naturally: the daily cap is shared across invocations.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const results: Record<string, unknown> = {};
  try {
    results.autoApprove = await runAutoApprove();
  } catch (e) {
    results.autoApprove = { error: (e as Error).message };
  }
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
  try {
    results.autopilot = await runAutopilot();
  } catch (e) {
    results.autopilot = { error: (e as Error).message };
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
