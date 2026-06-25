import Anthropic from "@anthropic-ai/sdk";
import { optionalEnv } from "./env";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}

export function model(): string {
  // Drafts, replies, follow-ups, extraction stay on Opus (customer-facing copy
  // quality). Override with ANTHROPIC_MODEL. The high-volume cost was the
  // per-partner classifier, which now uses classifyModel() (Haiku) instead.
  return optionalEnv("ANTHROPIC_MODEL", "claude-opus-4-8");
}

// Cheap model for the high-volume, low-complexity classification call (one per
// enriched partner). Haiku is ~20x cheaper than Opus and easily handles a
// qualify/decline + field-extraction task. Override with ANTHROPIC_MODEL_CLASSIFY.
export function classifyModel(): string {
  return optionalEnv("ANTHROPIC_MODEL_CLASSIFY", "claude-haiku-4-5-20251001");
}

// One structured-output call: returns schema-valid JSON.
export async function structured<T>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  model?: string;
}): Promise<T> {
  const res = await anthropic().messages.create({
    model: opts.model ?? model(),
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    output_config: {
      format: { type: "json_schema", schema: opts.schema },
    },
  } as Anthropic.MessageCreateParamsNonStreaming);
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("No text block in structured response");
  return JSON.parse(text.text) as T;
}

export async function plainText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
}): Promise<string> {
  const res = await anthropic().messages.create({
    model: opts.model ?? model(),
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("No text block in response");
  return text.text;
}
