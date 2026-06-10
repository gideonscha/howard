import { optionalEnv, requireEnv } from "./env";
import { unsubscribeToken } from "./tokens";

const BASE = "https://api.agentmail.to/v0";

async function am<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireEnv("AGENTMAIL_API_KEY")}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AgentMail ${init?.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export function howardInbox(): string {
  return optionalEnv("HOWARD_INBOX", "howard@magicportraitspartners.com");
}

// CAN-SPAM footer: physical postal address + working one-click unsubscribe.
export function canSpamFooter(recipientEmail: string): { text: string; html: string; unsubscribeUrl: string } {
  const base = requireEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
  const unsubscribeUrl = `${base}/api/u/${unsubscribeToken(recipientEmail)}`;
  const postal = requireEnv("POSTAL_ADDRESS");
  return {
    unsubscribeUrl,
    text: `\n\n—\nMagic Portraits · ${postal}\nIf you'd rather not hear from me again, one click and I'm gone: ${unsubscribeUrl}`,
    html: `<br><br><p style="color:#888;font-size:12px">Magic Portraits · ${postal}<br>If you'd rather not hear from me again, <a href="${unsubscribeUrl}">one click and I'm gone</a>.</p>`,
  };
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ message_id: string; thread_id: string }> {
  const footer = canSpamFooter(opts.to);
  return am(`/inboxes/${encodeURIComponent(howardInbox())}/messages/send`, {
    method: "POST",
    body: JSON.stringify({
      to: opts.to,
      subject: opts.subject,
      text: opts.text + footer.text,
      html: (opts.html ?? opts.text.replace(/\n/g, "<br>")) + footer.html,
      labels: ["outreach"],
      headers: {
        "List-Unsubscribe": `<${footer.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
}

export async function replyToMessage(opts: {
  messageId: string;
  to: string;
  text: string;
}): Promise<{ message_id: string; thread_id: string }> {
  const footer = canSpamFooter(opts.to);
  return am(
    `/inboxes/${encodeURIComponent(howardInbox())}/messages/${encodeURIComponent(opts.messageId)}/reply`,
    {
      method: "POST",
      body: JSON.stringify({
        text: opts.text + footer.text,
        headers: {
          "List-Unsubscribe": `<${footer.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    }
  );
}

export async function createInbox(): Promise<unknown> {
  const [username, domain] = howardInbox().split("@");
  return am(`/inboxes`, {
    method: "POST",
    body: JSON.stringify({
      username,
      domain,
      display_name: "Howard",
      client_id: "howard-partner-hunter-v1",
    }),
  });
}

export async function createWebhook(url: string): Promise<{ webhook_id: string; secret: string }> {
  return am(`/webhooks`, {
    method: "POST",
    body: JSON.stringify({
      url,
      event_types: [
        "message.received",
        "message.bounced",
        "message.complained",
        "message.delivered",
      ],
      client_id: "howard-webhook-v1",
    }),
  });
}
