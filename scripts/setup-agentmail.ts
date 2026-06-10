/**
 * One-time AgentMail provisioning. Run AFTER the Vercel deploy exists and
 * AGENTMAIL_API_KEY + PUBLIC_BASE_URL are available:
 *
 *   AGENTMAIL_API_KEY=am_... PUBLIC_BASE_URL=https://<app>.vercel.app \
 *     npx tsx scripts/setup-agentmail.ts
 *
 * Creates howard@magicportraitspartners.com (idempotent via client_id) and a
 * webhook pointing at /api/webhooks/agentmail, then prints the whsec_ secret
 * → paste it into Vercel as AGENTMAIL_WEBHOOK_SECRET.
 */
import { createInbox, createWebhook, howardInbox } from "../src/lib/agentmail";

async function main() {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error("Set PUBLIC_BASE_URL to the deployed app URL");

  console.log(`Creating inbox ${howardInbox()} ...`);
  try {
    const inbox = await createInbox();
    console.log("Inbox:", JSON.stringify(inbox, null, 2));
  } catch (e) {
    console.warn(`Inbox creation: ${(e as Error).message} (already exists is fine)`);
  }

  const url = `${base.replace(/\/$/, "")}/api/webhooks/agentmail`;
  console.log(`Creating webhook → ${url} ...`);
  const webhook = await createWebhook(url);
  console.log("\n=== SAVE THIS ===");
  console.log(`AGENTMAIL_WEBHOOK_SECRET=${webhook.secret}`);
  console.log("=================\n");
  console.log("Add it to Vercel env vars, then redeploy.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
