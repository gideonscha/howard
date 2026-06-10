import { db } from "./supabase";

// Lightweight run-progress channel for the /run page: stages report progress
// here while executing in the background; the page polls and re-renders.
export async function setProgress(text: string): Promise<void> {
  try {
    await db()
      .from("ph_config")
      .upsert({
        key: "_run_progress",
        value: JSON.stringify({ at: new Date().toISOString(), text }),
        updated_at: new Date().toISOString(),
      });
  } catch {
    // progress reporting must never break a run
  }
}

export async function getProgress(): Promise<{ at: string; text: string } | null> {
  const { data } = await db()
    .from("ph_config")
    .select("value")
    .eq("key", "_run_progress")
    .maybeSingle();
  if (!data?.value) return null;
  try {
    return JSON.parse(data.value);
  } catch {
    return null;
  }
}
