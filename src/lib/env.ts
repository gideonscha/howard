export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function optionalEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function sendingEnabled(): boolean {
  return process.env.SENDING_ENABLED === "true";
}

export function dailySendCap(): number {
  const n = Number(process.env.DAILY_SEND_CAP ?? 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export function followupDelaysDays(): number[] {
  const raw = process.env.FOLLOWUP_DELAYS_DAYS ?? "4,9";
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}
