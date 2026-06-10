"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { runSign } from "@/pipeline/sign";
import { runDiscover } from "@/pipeline/discover";
import { runEnrich } from "@/pipeline/enrich";
import { runScore } from "@/pipeline/score";
import { runDraft } from "@/pipeline/draft";
import { runSend } from "@/pipeline/send";
import { runFollowup } from "@/pipeline/followup";
import { runAttribute } from "@/pipeline/attribute";

// Server actions sit behind the Basic-auth middleware (dashboard-only).

// Dashboard-triggered stage runs (the curl alternative). Result lands in
// ph_config._last_run_result for display on /run.
export async function runStageAction(formData: FormData) {
  const stage = String(formData.get("stage"));
  const param = String(formData.get("param") ?? "").trim();
  let result: unknown;
  try {
    switch (stage) {
      case "discover":
        result = await runDiscover(param || undefined);
        break;
      case "enrich":
        result = await runEnrich(param ? Number(param) : 10);
        break;
      case "score":
        result = await runScore();
        break;
      case "draft":
        result = await runDraft(param ? Number(param) : 5);
        break;
      case "send":
        result = await runSend();
        break;
      case "followup":
        result = await runFollowup();
        break;
      case "attribute":
        result = await runAttribute();
        break;
      default:
        result = { error: `unknown stage ${stage}` };
    }
  } catch (e) {
    result = { error: (e as Error).message };
  }
  await db()
    .from("ph_config")
    .upsert({
      key: "_last_run_result",
      value: JSON.stringify({ stage, at: new Date().toISOString(), result }, null, 2),
      updated_at: new Date().toISOString(),
    });
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
  revalidatePath("/");
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
  revalidatePath("/");
}

export async function dismissAttention(formData: FormData) {
  const id = String(formData.get("id"));
  await db()
    .from("ph_outreach")
    .update({ needs_attention: false, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/");
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
  revalidatePath("/");
}

export async function markSampleDelivered(formData: FormData) {
  const partnerId = String(formData.get("partner_id"));
  await db()
    .from("ph_partners")
    .update({ sample_status: "delivered", updated_at: new Date().toISOString() })
    .eq("id", partnerId);
  revalidatePath("/samples");
}

export async function signPartner(formData: FormData) {
  const partnerId = String(formData.get("partner_id"));
  const pct = Number(formData.get("percentage") ?? 10);
  await runSign(partnerId, pct);
  revalidatePath("/pipeline");
}
