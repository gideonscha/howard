"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { runOnboard } from "@/pipeline/onboard";
import { runDiscover } from "@/pipeline/discover";
import { runEnrich } from "@/pipeline/enrich";
import { runScore } from "@/pipeline/score";
import { runDraft } from "@/pipeline/draft";
import { runSend } from "@/pipeline/send";
import { runFollowup } from "@/pipeline/followup";
import { runAttribute } from "@/pipeline/attribute";

// Server actions sit behind the Basic-auth middleware (dashboard-only).

// Dashboard-triggered stage runs. The action returns immediately; the stage
// executes in the background (waitUntil) and reports via ph_config:
// _run_progress while running, _last_run_result when done. /run live-polls.
export async function runStageAction(formData: FormData) {
  const { waitUntil } = await import("@vercel/functions");
  const { setProgress, getProgress } = await import("@/lib/progress");

  const stage = String(formData.get("stage"));
  const param = String(formData.get("param") ?? "").trim();

  // One run at a time: refuse if another run reported progress < 3 min ago.
  const current = await getProgress();
  if (
    current &&
    !current.text.includes("✅") &&
    Date.now() - new Date(current.at).getTime() < 3 * 60_000
  ) {
    return;
  }

  const execute = async () => {
    switch (stage) {
      case "pipeline": {
        // One-tap full pass: discover → enrich → score → draft top-up.
        const { runAutopilot } = await import("@/pipeline/autopilot");
        return runAutopilot();
      }
      case "discover":
        return runDiscover(param || undefined);
      case "enrich":
        return runEnrich(param ? Number(param) : 10);
      case "score":
        return runScore();
      case "draft":
        return runDraft(param ? Number(param) : 5);
      case "send":
        return runSend();
      case "followup":
        return runFollowup();
      case "attribute":
        return runAttribute();
      default:
        return { error: `unknown stage ${stage}` };
    }
  };

  await setProgress(`${stage}: started…`);
  waitUntil(
    (async () => {
      const { logActivity } = await import("@/lib/activity");
      let result: unknown;
      try {
        result = await execute();
        await logActivity("run", `manual ${stage} finished`, result);
      } catch (e) {
        result = { error: (e as Error).message };
        await logActivity("error", `manual ${stage} failed: ${(e as Error).message}`);
      }
      await db()
        .from("ph_config")
        .upsert({
          key: "_last_run_result",
          value: JSON.stringify({ stage, at: new Date().toISOString(), result }, null, 2),
          updated_at: new Date().toISOString(),
        });
      await setProgress(`${stage}: ✅ finished`);
    })()
  );
  revalidatePath("/run");
}

export async function approveDraft(formData: FormData) {
  const id = String(formData.get("id"));
  const subject = String(formData.get("subject") ?? "");
  const body = String(formData.get("body") ?? "");
  await db()
    .from("ph_outreach")
    .update({
      subject,
      body,
      status: "approved",
      needs_attention: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "draft");
  revalidatePath("/queue");
}

export async function rejectDraft(formData: FormData) {
  const id = String(formData.get("id"));
  await db()
    .from("ph_outreach")
    .update({
      status: "rejected",
      needs_attention: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("status", ["draft", "approved"]);
  revalidatePath("/queue");
}

export async function dismissAttention(formData: FormData) {
  const id = String(formData.get("id"));
  await db()
    .from("ph_outreach")
    .update({ needs_attention: false, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/queue");
}

export async function markSampleShipped(formData: FormData) {
  const partnerId = String(formData.get("partner_id"));
  await db()
    .from("ph_partners")
    .update({
      sample_status: "shipped",
      sample_shipped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", partnerId);
  revalidatePath("/samples");
  revalidatePath("/queue");
}

export async function markSampleDelivered(formData: FormData) {
  const partnerId = String(formData.get("partner_id"));
  await db()
    .from("ph_partners")
    .update({ sample_status: "delivered", updated_at: new Date().toISOString() })
    .eq("id", partnerId);
  revalidatePath("/samples");
}

// Manual "Onboard" — drafts the onboarding reply (both codes + link + address
// ask) into the approval queue. Human reviews and sends; nothing auto-sends.
export async function onboardPartner(formData: FormData) {
  const partnerId = String(formData.get("partner_id"));
  await runOnboard(partnerId);
  revalidatePath("/queue");
  revalidatePath("/pipeline");
  revalidatePath(`/pipeline/${partnerId}`);
}
