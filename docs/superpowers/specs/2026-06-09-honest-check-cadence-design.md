# Honest Check Cadence — Design

**Date:** 2026-06-09
**Status:** Approved (brainstorming), ready for plan
**Branch base:** `port-fixes-onto-2.86`

## Goal

Make the operator's "check & intro cadence" setting mean exactly what it says.
After the (fixed) first check at 1 hour, the campaign re-checks for accepted
connections at the interval the operator picked — the same interval whether the
campaign is still sending connection requests or has finished sending. No hidden
6-hour rule, no hidden "minimum 1 hour" override.

## Problem (verified against the live app)

A campaign started `2026-06-09T13:12:12Z` with the cadence set to "every hour"
did its first acceptance check at `14:12:25Z` — exactly 60 minutes in — then
fired intros. That is *correct current behaviour*, but it exposed how
confusing/dishonest the controls are. Three separate timing regimes are in play
and the operator's number touches almost none of them:

1. **First check** is gated only by a fixed **1-hour blackout**
   (`FIRST_HOUR_BLACKOUT_MS`, `campaign.js:76`/`:2900`; idle equivalent
   `IDLE_CAMPAIGN_MIN_DURATION_MS`, `:79`/`:176`). The operator's cadence has no
   effect on it — a 1h or a 6h selection both check first at 1h. The 6h
   "interval since last check" passes trivially on the first check because the
   stored last-check time is `0`/ancient (verified in `bulk-check-cooldown.json`:
   this sheet had no prior entry, so `now - 0 >= 6h` is always true).

2. **While still sending**, the gap *between* checks is a hardcoded **6 hours**
   (`IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS = 6h`, used by the in-batch trigger
   `campaign.js:2902` and the idle trigger `campaign.js:180`). The operator's
   cadence is never read here.

3. **After sending finishes (monitoring)**, the operator's cadence *is* used, but
   floored: `Math.max(60, campaign.checkIntervalMinutes || 60)`
   (`campaign.js:4202`). Sub-hour picks are silently raised to 1h; only the very
   first monitoring check (`transitionToMonitoring`,
   `campaign-state-transitions.js:25-26`) is honored unfloored.

The wizard dropdown even offers **15 min / 30 min** (`index.html:538-539`) — values
the engine can never honor — and the in-batch log line hardcodes "60-min cooldown
elapsed" (`campaign.js:2903`) while the real constant is 6h. The knob lies, and
its label lies.

## Desired behaviour (the contract)

- **First check: always at 1 hour.** Unchanged. (Explicit operator decision.)
- **After the first check: re-check every X**, where X is the operator's selected
  cadence — applied identically during sending and during monitoring.
  - "every hour" → checks at 1h, 2h, 3h, 4h …
  - "every 3 hours" → checks at 1h, then 4h, 7h …
- **One number, start to finish.** No 6-hour sending rule; no silent flooring.
- The picker only *offers* values the engine honors exactly. The minimum offered
  value equals the engine's safety minimum, so they can never disagree.

## Scope — which campaigns this touches

Verified single source of truth: `public/js/campaign-modes.mjs`
(`usesMonitoringCadence`). Exactly **two** modes have the recurring auto-check
cadence, and both are already handled together by every trigger site and by the
UI predicate:

- `connect_and_introduce` (CC+IC) — fires the 3-way intro DM
- `connect_and_message` (CC+DM) — fires the post-acceptance DM

The fix therefore covers **both** automatically; there is no third auto-check
campaign type.

**Explicitly out of scope (checked, genuinely unaffected — they have no cadence):**

| Mode | Check behaviour | Why unaffected |
|---|---|---|
| `check_status` | one-time sweep (the manual "check now" mode) | runs once, no recurring interval |
| `message_only` (DM), `introduce_back` (IB) | optional one-time preflight check | runs once, no recurring interval |
| `connect_only`, `inmail_only`, `open_profile_only` | no checks | nothing to change |

## Design

### Single source of truth for the minimum

Add `MIN_CADENCE_MINUTES = 60` to `public/js/campaign-modes.mjs` (the existing
shared module). It anchors both:
- the picker's smallest option (1h), and
- the engine's intake clamp.

Because the clamp value equals the smallest pickable value, the clamp never alters
a real selection — it is a documented backstop against a malformed payload, not a
hidden override.

### Behaviour changes (engine — `src/campaign.js`, `src/campaign-state-transitions.js`)

1. **Intake clamp (once).** In `startCampaign`, clamp the incoming cadence:
   `checkIntervalMinutes = Math.max(MIN_CADENCE_MINUTES, Number(checkIntervalMinutes) || MIN_CADENCE_MINUTES)`.
   All downstream timing reads this single clamped value.

2. **In-batch trigger** (`campaign.js:2902`): replace
   `IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS` with `checkIntervalMinutes * 60_000`
   (in scope inside `startCampaign`). The 1-hour blackout at `:2900` **stays**.

3. **Idle trigger** (`shouldFireIdleBulkCheck`, `campaign.js:172-182`): make the
   between-checks interval a parameter instead of the module constant. Add
   `intervalMs` to the ctx object passed at the call site (`campaign.js:3300-3308`,
   where `checkIntervalMinutes` is in scope) and change `:180` to compare against
   `ctx.intervalMs`. The 1-hour age gate (`IDLE_CAMPAIGN_MIN_DURATION_MS`, `:176`)
   **stays** (this is the idle path's "first check at 1h").

4. **Monitoring reschedule** (`campaign.js:4202`): drop the `Math.max(60, …)`
   floor — use `campaign.checkIntervalMinutes` directly. (Already clamped at
   intake, so still never below the minimum.) The initial `nextCheckAt` in
   `transitionToMonitoring` is already honest and stays as-is.

5. **Retire** `IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS` once it has no remaining
   readers. `FIRST_HOUR_BLACKOUT_MS` and `IDLE_CAMPAIGN_MIN_DURATION_MS` remain.

6. **Fix the lies:** update the in-batch log string (`campaign.js:2903`) to state
   the real cadence instead of "60-min cooldown elapsed"; reconcile the
   contradictory comments (`campaign.js:61-64` vs `72-75`).

### UI change (`public/index.html`, `public/js/app.js`)

Replace the cadence dropdown options (`index.html:538-544`) with:

```
Every  [ 1 hour ▾ ]   → 60 / 120 / 240 / 360 / 720   (default 60)
```

Remove the 15-minute and 30-minute options. Update the helper copy to be honest
and to note it's per account: e.g. *"How often we check each account for new
acceptances — during sending and after. A bit later if all browsers are busy
sending."* The `usesMonitoringCadence` gate that shows the control (and carries
`checkIntervalMinutes` in the payload) is unchanged — it already covers CC+IC and
CC+DM.

## Testing

- **Idle trigger** (`tests/idle-bulk-check.test.js`): with `intervalMs = 1h`,
  `lastBulkCheckAt` 65 min ago → fires; 50 min ago → does not. Confirms it reads
  the passed interval, not a constant.
- **Monitoring reschedule:** `checkIntervalMinutes = 120` → next boundary is
  prev + 120 min (not floored to 60); `= 60` → prev + 60 min. Proves the
  `Math.max` floor is gone.
- **Intake clamp:** `15 → 60` (backstop); `180 → 180` (untouched).
- **First check unchanged:** in-batch and idle both still gated to 1h regardless
  of cadence (e.g. cadence = 360 still allows the first check at campaign age 1h).
- **`transitionToMonitoring`:** first monitoring check = sendingEnd + cadence
  (regression guard that it stays honest).

## Non-goals

- No change to the fixed 1-hour first check.
- No change to the one-time-check modes (`check_status`, DM/IB preflight).
- No refactor unifying the three trigger sites into one scheduler (noted as
  possible future cleanup; out of scope here to keep the diff small on a fragile
  loop right after a stability fix).
- Browser concurrency cap (`MAX_CONCURRENT_PROFILES`) stays as-is; it bounds how
  fresh checks can be under load, but exposing/raising it is a separate question.
