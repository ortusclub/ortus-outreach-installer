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

## Still open / not in scope here

- A hard cap (vs warning) on reckless daily limits — left as a warning so the
  operator keeps control.
- UI surfacing of the backoff/park state and the `identity_unverified` /
  `reckless_daily_limit` Ops Log events (logged today; no dashboard card yet).
- End-to-end verification against a live rate-limited LinkedIn session.
