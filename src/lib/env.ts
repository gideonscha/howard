export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function optionalEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

// Public base URL for wrapped links (unsubscribe, click redirects). Prefers
// an explicit PUBLIC_BASE_URL; otherwise uses Vercel's built-in production
// domain so it works without any extra env config.
export function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) return `https://${prod}`;
  const dep = process.env.VERCEL_URL;
  if (dep) return `https://${dep}`;
  throw new Error("No PUBLIC_BASE_URL / VERCEL_PROJECT_PRODUCTION_URL available");
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
