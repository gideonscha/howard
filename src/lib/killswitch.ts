import { sendingEnabled } from "./env";
import { db } from "./supabase";

// The master gate. Every real-world send funnels through here.
// While SENDING_ENABLED !== "true", the would-be send is logged (dry_run=true)
// and nothing reaches AgentMail.
export async function gateSend(
  outreachId: string | null,
  email: string
): Promise<{ allowed: boolean }> {
  if (sendingEnabled()) return { allowed: true };
  console.log(
    `[DRY-RUN] SENDING_ENABLED=false — would send to ${email} (outreach ${outreachId ?? "n/a"})`
  );
  await db().from("ph_send_log").insert({
    outreach_id: outreachId,
    email,
    dry_run: true,
  });
  const { logActivity } = await import("./activity");
  await logActivity("send", `DRY-RUN — would send to ${email} (kill-switch off)`);
  return { allowed: false };
}
