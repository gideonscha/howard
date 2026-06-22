# Attribution: tying a partner's tracking link to a Shopify order

**Question (from the trial spec):** the customer code `STAR-C6538` is shared
across all partners, so a redemption can't tell us *which* partner drove it.
For the 20% commission we need attribution to come from the partner's tracking
link (`/c/{token}` → `/memorial`). **Can a `/memorial` visit that arrived via a
partner's `/c/` link be tied through to the resulting Shopify order?**

**Short answer: partially, best-effort — not reconciliation-grade with this repo
alone.** Good enough to *flag* attribution during the trial; **not** good enough
to *pay commission* on without a refinement. Here's the full picture.

---

## What we control (this repo)

`/c/{token}` does two things before redirecting:

1. **Logs the click** to `ph_clicks` (`partner_id`, `outreach_id`, `clicked_at`).
   This is a clean, first-party record that *a partner's link was clicked* — we
   own it, it's reliable, and it's already wired.
2. **Redirects to `/memorial` with attribution params appended** (added in this
   change):
   ```
   https://magicportraits.ai/memorial
     ?utm_source=howard
     &utm_medium=partner
     &utm_campaign=star-in-heaven
     &ref={partner_id}
     &howard_oid={outreach_id}
   ```

That's the entire surface we control. Everything past the redirect lives on the
Shopify storefront, which is a **separate property** (not in this repo).

## What Shopify captures on its own

- **UTM params → customer journey.** Shopify records the landing-page URL
  (query string included) of a buyer's visits in the order's
  `customerJourneySummary` (`firstVisit` / `lastVisit`, and `moments` on Plus).
  Because our `ref` and `howard_oid` ride in that landing URL, they *can* be
  read back off the order via the Admin API — **if** the converting session is
  the tracked one.
- **This is the only native tie-through.** Shopify does **not** natively expose
  `ref`/`howard_oid` as structured order fields; they're only embedded inside
  the recorded landing-page string.

### Why it's only best-effort

The link → order chain breaks in ordinary cases:

- **Time gap.** Pet-memorial purchases are considered; a family clicks today and
  buys in two weeks. If cookies expired/cleared, the journey no longer points at
  our link.
- **Cross-device.** Click on the email on a phone, buy later on a laptop → no
  shared session.
- **Consent / tracking prevention.** Safari ITP, cookie banners, and ad
  blockers drop the session that carries the UTM.
- **Plan limits.** Full `moments` history is a Shopify Plus feature; lower plans
  give a thinner journey, often just first/last touch.

Net: you'll catch *some* orders, miss others, and can't prove completeness — so
you can't safely base a payout on it.

## What reconciliation-grade attribution would take

Pick one (in order of effort):

1. **Per-partner discount codes** *(most reliable, explicitly out of scope this
   trial).* One code per partner instead of the shared `STAR-C6538`. Redemption
   then *is* the attribution — no session/cookie dependence. This is the clean
   answer; it's parked only because you chose two fixed codes for the cohort.
2. **Storefront capture of `ref` into the order** *(storefront work, outside
   this repo).* A small theme/app snippet reads `ref`/`howard_oid` from the
   landing URL, stashes it (cookie/localStorage), and writes it to **cart note
   attributes** so it lands as a structured field on the order. We could then
   read it deterministically via the Admin API and write `ph_referrals`. Robust
   within a session/device; still vulnerable to long gaps and cross-device.
3. **Order-time matching heuristic** *(brittle — not recommended).* Match
   `ph_clicks` to orders by email + time window. Noisy; do not pay on it.

## Recommendation for the trial

- **Keep the shared code + the UTM/`ref` link (done).** It costs nothing and
  gives a best-effort signal plus a clean first-party click log in `ph_clicks`.
- **Treat attribution as "via link, unconfirmed."** When commission becomes
  real, do **not** auto-write `ph_referrals` from journey data alone. Either:
  (a) move to **per-partner codes** for partners you're paying, or (b) add the
  **storefront `ref` → order-note capture** so the tie-through is deterministic.
- **For now, `ph_referrals` stays manual / unwired from the link.** The wiring
  is feasible but only as reliable as the storefront capture above — which
  doesn't exist yet. Flagged here so the gap is explicit before any payout.

> **Bottom line:** link → order is *traceable* (UTM in the Shopify customer
> journey + our `ph_clicks` log) but not *provable*. Fine to surface in the
> dashboard as a soft signal; refine to per-partner codes or storefront capture
> before a dollar of commission is paid.
