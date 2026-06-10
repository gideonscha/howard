"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { runSign } from "@/pipeline/sign";

// Server actions sit behind the Basic-auth middleware (dashboard-only).

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
