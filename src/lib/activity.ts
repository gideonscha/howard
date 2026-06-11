import { db } from "./supabase";

export type ActivityKind = "run" | "autopilot" | "send" | "inbound" | "suppression" | "error";

// Fire-and-forget event log feeding the /activity page. Must never break a run.
export async function logActivity(
  kind: ActivityKind,
  message: string,
  data?: unknown
): Promise<void> {
  try {
    await db()
      .from("ph_activity")
      .insert({ kind, message, data: data ?? null });
  } catch (e) {
    console.warn(`activity log failed: ${(e as Error).message}`);
  }
}
