# Pre-Send Identity Gate — Design & Incident Record

**Date:** 2026-06-15 · **Version:** v2.96.0 · **Branch:** `connect-identity-gate`

## The incident (2026-06-11, campaign `SoEC_NA_CCI`, account angelica.balatbat@ortus.solutions)

A `connect_only` CC campaign sent connection requests where **the note name was
correct (from the sheet row) but the request reached the WRONG LinkedIn
person** — including people who were never in any sheet, and an internal Ortus
colleague (note "Hi Divya" reached "Dion Kadriu"). The team caught it, stopped
the run, and withdrew the requests.

## Root cause (evidence-backed, not inferred)

1. **The sheet's LinkedIn-URL column holds encoded `/in/ACwAA…` member-URN
   URLs** for many rows (proven from operator data: Pachaiyappan, Ashwin, Rishi
   all carried encoded links; some were even case-corrupted/lowercased →
   "Profile not found").
2. **Navigating those encoded URLs is unreliable under load.** The operator ran
   `daily limit: 200` on a single account for ~18h. Under LinkedIn
   rate-limiting/session degradation, the encoded URL **redirects/resolves to a
   different profile or a fallback page**. The run log proves the race directly:
   repeated `Execution context was destroyed, most likely because of a
   navigation` and `lead_timeout_watchdog` errors — the page navigating *while
   the app acted on it*.
3. **There was no identity check before the send.** The connect request is sent
   inside `performOutreach` (campaign.js, the `performOutreach(...)` call in the
   per-lead loop). The only identity check (`verifyConnectIdentity`) ran
   *afterward* and merely *withheld the captured member-ID from the sheet* — it
   could not un-send. Every click-time guard in `actions.js` validates against
   the **loaded page's own `<h1>`**, never against the sheet lead, so a
   wrong-whole-page load passed every guard.

Net: the correctly-named note was clicked onto whatever profile LinkedIn landed
on mid-navigation.

## Design — make a wrong send structurally impossible

**Pre-send identity gate, skip-on-doubt, with retry.** For connect modes
(`force_connect`, `force_connect_op_fallback`) on `/in/` URLs only:

1. Navigate to the lead URL, let redirects settle, capture the loaded profile
   (`captureProfileMeta` — now also returns the display **name**).
2. Verify the loaded profile **against the sheet row** via
   `verifyConnectIdentity({ strict: true })`:
   - **member-number match** (when the row has a source member id) — authoritative.
   - **name match** (First+Last, normalized: diacritics/credentials/emoji
     stripped, order-free) — confirms slug rows and **catches the bad-data case
     even when a member id is absent or itself wrong**. A clear name *mismatch*
     hard-rejects even if the member number matches.
   - **vanity-slug-stable** — navigated to a slug and stayed on it.
   - **urn-prefix match** — encoded token corroboration.
   - Anything else (profile didn't load, bare member id with no corroboration)
     → **not confirmed**.
3. **Retry up to 5 times** (re-navigate). A capture throw
   ("Execution context destroyed") is itself the degradation signal → retry.
4. **Confirmed →** call `performOutreach` with `state.skipNavigation = true` so
   the send **reuses the verified page** (one navigation — closes the
   verify-vs-send race). This is the only change to the off-limits
   `outreach.js`: a guard around the single `page.goto`, navigating as before
   for every other caller.
5. **Unconfirmed after 5 →** do **not** send. Log loudly, emit an Ops Log
   `identity_unverified` event with **intended vs loaded identity**, write an
   audit breadcrumb to the sheet, and `continue`. The row is left
   *non-terminal* (no `Skipped:` Stage) so a future, non-degraded run can retry
   a genuine lead whose page merely failed to load this time.

## What this guarantees / costs

- **Guarantee:** no connection request fires in a connect mode unless the loaded
  profile is positively confirmed to be the intended sheet lead.
- **Cost (accepted by operator):** some legitimate leads are skipped when their
  identity can't be confirmed in the moment — strictly preferred over a wrong
  send. They remain eligible for the next run.

## Backward compatibility

`verifyConnectIdentity`'s new params (`capturedName`, `landedUrl`, `sourceName`,
`strict`) all default to inert. The two existing post-send callers pass none, so
their lenient behaviour and all prior tests are unchanged.

## Files

- `src/profile-identity.js` — name normalization/match, `vanitySlug`, strict mode in `verifyConnectIdentity`.
- `src/linkedin/helpers.js` — `captureProfileMeta` now returns `name`.
- `src/campaign.js` — `gateConnectIdentity` + `MAX_IDENTITY_ATTEMPTS`; gate wired into the per-lead loop; `skipNavigation` passed to `performOutreach`.
- `src/linkedin/outreach.js` — `state.skipNavigation` seam around the lead-profile `page.goto` (authorized minimal change).
- `tests/profile-identity.test.js` — strict + name-match coverage incl. the real incident case.

## Phase 2 (shipped v2.96.1) — degradation handling

Failure→pacing feedback, so the loop stops hammering a degrading session:

- **Per-account degradation streak.** `isDegradationSignal()` classifies an
  outcome as degradation (nav race / `lead_timeout_watchdog` / `Profile not
  found` / `Navigation timeout` / `net::ERR_` / rate-limit / identity-unverified)
  vs a benign skip. A clean send resets the streak.
- **Exponential backoff.** `degradationBackoffMs(base, streak, {maxMult, maxMs})`
  doubles the inter-lead wait per consecutive degraded lead, capped at 32× and
  an absolute 20-minute ceiling — giving LinkedIn time to recover instead of the
  old fixed 15-45s pace.
- **Park on persistence.** Identity-unverified skips now also feed
  `consecutiveSkips`, so the existing `SKIP_PARK_THRESHOLD` parks the account if
  it never recovers (this path previously bypassed the park check entirely).
- **Reckless-settings guard.** At start, a connect-mode `dailyLimit > 80` logs a
  loud warning + an Ops Log `reckless_daily_limit` event (the incident ran
  200/day on one account).

Both pacing helpers are pure and unit-tested (`tests/degradation-backoff.test.js`).

## v2.96.2 — adversarial review findings & fixes

Four read-only review agents (wrong-send, backoff/park, logging, edge-cases) attacked the v2.96.0/.1 work. Confirmed sound: the gate's happy `/in/` path, no stale `skipNavigation` leak, no page re-acquisition between gate and send, per-account streak maps are race-free, the gate-path park is clean, and degradation errors are *returned* (outreach.js:887) not thrown, so they reach the `isDegradationSignal` increment. **Holes found and FIXED in v2.96.2:**

- **`/sales/` URLs bypassed the gate (HIGH).** The gate only fired on `/in/`, but performOutreach rewrites `/sales/lead|people/<urn>` → `/in/` and connects — so Sales-Nav rows connected ungated with the same mis-load risk. Fix: gate now fires on `/sales/lead|people/` too, and `salesNavToInUrl()` normalizes them to `/in/<urn>` for verification (pure + tested). Legacy `/sales/profile/<numeric>,…,NAME_SEARCH` has no AC-urn → gate can't load a profile → skipped (safe).
- **Backoff bypassed on the identity-gate path (MEDIUM).** The gate skip `continue`d past the end-of-iteration delay block, so consecutive gated leads (the exact incident signature) spun at gate-internal speed with no inter-lead pacing — only the park-at-8 braked it. Fix: the gate-skip path now applies the same exponential backoff sleep before `continue`.
- **`isDegradationSignal` missed real signals (MEDIUM).** Added `HTTP 429` / `429` / `linkedin_error` / `something went wrong` / `LINKEDIN_ERROR_TOAST` / `SEND_NOT_CONFIRMED` so they escalate the backoff (429 is also still hard-parked at 2 by its own counter).
- **Streak reset too eagerly (LOW-MED).** It reset on any SUCCESS_ACTION incl. cheap `already_processed` early-returns, which could mask an ongoing degradation streak. Fix: reset only on outcomes that prove a healthy page interaction (connection_sent / message_sent / inmail_sent / op_message_sent / already_connected / status_accepted).
- **Ops Log dropped the intended-vs-loaded detail + delayed short-run events.** The bridge writes `reason || details` (one column), so the `details` field was dropped when `reason` was set. Fix: folded intended/loaded into `reason` (and made it greppable for `identity_unverified`). Added a `flushOpsLog()` drain at campaign end so short-run events (e.g. `reckless_daily_limit`) aren't left on the 30s timer.

## Still open / not in scope here

- **OP-direct mode (`force_connect_op_fallback`) re-navigation (MEDIUM, residual).** When "Message Open Profiles Directly" is on, the OP-first path resolves a Sales-Nav URL *from the verified page* and `page.goto`s to it inside performOutreach — a second navigation `skipNavigation` doesn't cover, so the Sales-Nav connect fallback isn't re-verified. Mitigating: the Sales-Nav URL is derived from the just-verified profile (same person), and it's an opt-in mode not involved in the incident. **Recommendation:** don't pair "Message Open Profiles Directly" with encoded/Sales-Nav sheets until a follow-up adds a post-navigation re-check (needs an authorized actions.js/outreach.js change).
- **CC+IC auto-intro path (auto-intro.js).** The post-acceptance intro DM runs outside performOutreach and isn't gated; recipient is pinned by publicId in the compose URL (lower blast radius than a profile Connect click), but identity isn't re-verified against the sheet at intro time. Separate work item.
- **Operator action — verify the Ops Log Apps Script is current.** The two new events land only if the deployed script behind `OPS_LOG_WEBAPP_URL` is the v2.93+ `ops-log-bridge.js` (single Events tab). If a pre-v2.93 build is deployed, redeploy it (Extensions → Apps Script → Deploy → New version).
- **Reckless daily limit is advisory (by design).** The >80 guard warns + logs but does not clamp — no pacing can make e.g. 200/day on one account safe (LinkedIn's ceiling is ~100/week); the operator must lower it. Backoff + park are the reactive safety net if they don't.

- A hard cap (vs warning) on reckless daily limits — left as a warning so the
  operator keeps control.
- UI surfacing of the backoff/park state and the `identity_unverified` /
  `reckless_daily_limit` Ops Log events (logged today; no dashboard card yet).
- End-to-end verification against a live rate-limited LinkedIn session.
