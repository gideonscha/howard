# Howard — the Partner-Hunter

B2B2C outreach agent for Magic Portraits. Recruits US pet memorial businesses
(crematoriums, pet cemeteries, aftercare networks, vets with aftercare) as
referral partners for the **Star in Heaven** memorial portrait theme. Never
contacts grieving individuals — businesses only.

**Build-vs-activate:** all pipeline stages run live from day one, but nothing
leaves AgentMail while `SENDING_ENABLED=false` (the master kill-switch). Even
when enabled, only drafts Gideon has approved in the dashboard ever send.

## Architecture

- **Vercel** (this Next.js app): pipeline stages as API routes, hourly cron
  dispatcher, AgentMail inbound webhook, auth-gated dashboard.
- **Supabase** `partner-hunter` (`nrxmuhciadrqprmnwvmp`, us-east-1): tables
  `ph_partners`, `ph_outreach`, `ph_referrals`, `ph_suppression`, `ph_config`,
  `ph_send_log` (RLS on, service-role only).
- **AgentMail**: `howard@magicportraitspartners.com`, send + reply + Svix-signed
  inbound webhooks.
- **Firecrawl**: discovery scraping (IAOPCC → Gateway → Lap of Love) + site
  fetch for enrichment.
- **Anthropic API**: enrichment classification, drafting, reply triage
  (`claude-opus-4-8`, structured outputs).
- **Shopify Admin API**: referral discount codes + order attribution.
- **ZeroBounce**: email verification — `send` refuses anything not `verified`.

## Pipeline

| Stage | Trigger | What it does |
|---|---|---|
| `discover` | manual (`POST /api/run/discover?source=iaopcc\|gateway\|lapoflove`) | Sources one bounded slice, dedupes vs partners + suppression → `sourced` |
| `enrich` | manual (`/api/run/enrich?limit=10`) | Site fetch + Claude classification + ZeroBounce → `qualified` |
| `score` | manual (`/api/run/score`) | fit_score: segment intent + reachability + warmth + chain value → `queued` |
| `draft` | manual (`/api/run/draft?limit=5`) | Personalised first touch → `ph_outreach.status='draft'`. Never sends |
| `send` | hourly cron | Approved-only, daily cap, suppression check, CAN-SPAM footer, **kill-switch gated** |
| webhook | AgentMail | Replies → triage (sample request / escalation / info request), pause cadence; bounces/complaints → suppression |
| `followup` | hourly cron | Touch 2–3 after 4/9 days no-reply + post-sample check-in, drafts only, **kill-switch gated** |
| `sign` | dashboard / `/api/run/sign?partner_id=` | Mints Shopify code, writes `ph_referrals` → `signed` |
| `attribute` | daily (06:00 UTC inside cron tick) | Shopify orders by code → `orders_count`/`revenue` |

All `/api/run/*` and the cron route require `Authorization: Bearer $CRON_SECRET`.

## Env vars (set in Vercel → Project → Settings → Environment Variables)

See `.env.example` for the full annotated list:
`SENDING_ENABLED` (=false until activation), `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `AGENTMAIL_API_KEY`, `AGENTMAIL_WEBHOOK_SECRET`,
`HOWARD_INBOX`, `FIRECRAWL_API_KEY`, `FIRECRAWL_RUN_CREDIT_BUDGET`,
`ZEROBOUNCE_API_KEY`, `GOOGLE_PLACES_API_KEY` (optional, vet segment),
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `SHOPIFY_SHOP_DOMAIN` (*.myshopify.com),
`SHOPIFY_ADMIN_TOKEN`, `DAILY_SEND_CAP`, `FOLLOWUP_DELAYS_DAYS`,
`POSTAL_ADDRESS`, `PUBLIC_BASE_URL`, `SELF_DEMO_URL`, `DASHBOARD_USER`,
`DASHBOARD_PASSWORD`, `CRON_SECRET`, `UNSUBSCRIBE_SECRET`.

No secret is ever committed; the deployed worker reads everything from env.

## One-time setup after env vars exist

```bash
# Creates howard@ inbox + the inbound webhook; prints AGENTMAIL_WEBHOOK_SECRET
AGENTMAIL_API_KEY=am_... PUBLIC_BASE_URL=https://<app>.vercel.app npm run setup:agentmail
```

## Offer terms (ph_config)

Until rows exist in `ph_config`, drafts never state numbers — structure only.
Populate when terms are decided:

```sql
insert into ph_config (key, value) values
  ('commission_percent', '15'),
  ('donation_amount', '25'),
  ('sample_set_contents', '3 Star in Heaven tiles, 8x8');
```

## Verify

```bash
APP=https://<app>.vercel.app
AUTH="Authorization: Bearer $CRON_SECRET"

# 1. Discover a slice, then enrich/score/draft
curl -X POST -H "$AUTH" "$APP/api/run/discover?source=iaopcc"
curl -X POST -H "$AUTH" "$APP/api/run/enrich?limit=10"
curl -X POST -H "$AUTH" "$APP/api/run/score"
curl -X POST -H "$AUTH" "$APP/api/run/draft?limit=5"

# 2. Scored queue (Supabase SQL editor)
#    select business_name, state, fit_score, stage, email_status
#    from ph_partners where stage='queued' order by fit_score desc;

# 3. Dry-run proof: approve a draft in the dashboard, then
curl -X POST -H "$AUTH" "$APP/api/run/send"
#    → {"sent":0,"dryRun":1,...}; Health view shows the dry-run row;
#    AgentMail dashboard shows nothing sent.

# 4. Unsubscribe: open the /api/u/<token> link from any draft footer
#    → ph_suppression row appears; next send run skips that address.

# 5. Sign: in a partner page click "Mint code + sign"
#    → Shopify admin shows the STAR-... discount; ph_referrals row exists.
```
