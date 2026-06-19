# 429-Aware Connect Resilience — Design (Fix B)

**Date:** 2026-06-19
**Status:** Draft for review
**Branch:** eod-2102-integration
**Research basis:** `docs/superpowers/research/2026-06-19-429-rate-limiting.md`
**UI reference:** `public/sketches/2026-06-19-lead-source-and-429-ui.html` (B1, B2)

## Problem

Operators set inter-lead intervals to 10–20s → LinkedIn 429 storms → pages
mis-load/wedge → retries don't reset them → **mass skipping**; and the app keeps
hammering through throttling, walking accounts toward checkpoints/restrictions.
Today's retry re-issues `page.goto(sameURL)` (a no-op for an SPA) or reuses the
wedged page; there's no floor or warning on the interval; and a 429 is treated the
same as the (very different) weekly invite cap.

## Goal

Make the connect path resilient under throttling: classify failures correctly, reset
the page properly on transient glitches, back off (with the operator's chosen
pause behavior) on real throttling, and steer operators away from rate-limit-inducing
intervals — **all without touching `src/linkedin/outreach.js` / `actions.js`** (these
already surface the signals: `rate_limited` page-error skips, `WEEKLY_LIMIT` throws,
`VOYAGER_REJECTED: HTTP 429`). The fix lives in `campaign.js` (gate loop, retry loop,
delays, parking) + server + frontend.

## Non-goals

- No edits to off-limits `outreach.js`/`actions.js`. We read their results/errors.
- No change to the identity gate's verdict logic (Fix A territory).
- Account warmup ramp + `dailyLimit` default reconsideration: noted by research,
  deferred (product decision, not this fix).

## Design

### B0 — Classify the failure (pure, the spine)

`classifyConnectFailure(errorMsg)` → one of:
- `'invite_cap'` — `/weekly invitation|invitation limit|WEEKLY_LIMIT/i`. Quota spent;
  retrying is harmful. **Stop sending on this account for the cycle** (keep monitoring).
- `'challenge'` — `/checkpoint|captcha|unusual activity|verify (you|your)|challenge/i`.
  **Halt the account, surface to a human.** Never auto-retry through it.
- `'throttle'` — `/429|rate[_ ]limited|too many requests|resource level throttle|VOYAGER_REJECTED/i`.
  Request-rate limit; back off. Pause the account **iff** the operator toggle is on.
- `'transient'` — `/Execution context was destroyed|navigation|timeout|net::ERR_|no modal appeared|context was destroyed/i`.
  Render glitch → guarded retry with a real page reset.
- `'benign'` — anything else (already-connected, not-found, etc.): existing handling.

Unit-tested. Used at the per-lead failure-handling points in `startCampaign`.

### B1 — Page-reset retry (about:blank → re-goto → re-verify)

Replace the soft retries:
- **Gate retry loop** (`campaign.js:~546`): before each *re*-navigation (attempt > 1),
  `await page.goto('about:blank',{timeout:5000}).catch(()=>{})` then the existing
  `goto(navUrl)`. Forces a real teardown (an SPA same-URL goto can be a no-op).
- **Connect retry loop** (`campaign.js:~3281`): only retry when the prior failure
  classified `transient`. On such a retry: `about:blank` → **re-run `gateConnectIdentity`**
  (fresh load + re-verify, preserving the wrong-person safeguard) → if verified,
  `performOutreach(..., skipNavigation:true)`; if the gate now fails, treat as the
  existing identity-unverified skip. For `throttle`/`invite_cap`/`challenge`, do **not**
  retry inline — route to B0's handling.
- `waitUntil` stays `domcontentloaded` (already) + the existing top-card render wait;
  never `networkidle`.

### B2 — Pacing controls (operator-facing)

- **No hard floor** (operator decision). Default stays 30–60s.
- **Big red disclaimer** (sketch B1) appears when the low end `#within-batch-min` < 30s,
  warning that it causes the 429 storms / skipping / restriction risk. Shown live as the
  operator types; clears at ≥30. Applies on the wizard AND on rerun/restore (an old 10s
  config surfaces the warning when reopened).
- **Pause-on-throttle toggle** (sketch B2): new Campaign Settings switch
  `pauseOnThrottle`, **default ON**. On → a `throttle`-classified failure pauses that
  account (jittered backoff / park) and other accounts continue. Off → the account keeps
  sending through throttling (faster, riskier). Challenges always halt regardless of the
  toggle. Threaded start body → `startCampaign` → `campaign.pauseOnThrottle`.

### B3 — Jittered backoff

`degradationBackoffMs` is currently deterministic (`base * 2**streak`). Add **full
jitter**: `random(0, min(cap, base * 2**streak))` (research: jitter is both anti-thundering-
herd and anti-detection — deterministic backoff is itself a fingerprint). Keep the cap
(20min) and honor a `Retry-After` value if one is ever surfaced (`wait = max(retryAfter,
jittered)`). Pure + tested.

## Files

- `src/campaign.js` — `classifyConnectFailure` (pure, exported), jitter in
  `degradationBackoffMs` (or a jittered wrapper), `pauseOnThrottle` in the
  `startCampaign` signature, the about:blank gate-retry + connect-retry rework, and the
  failure routing.
- `server.js` — accept `pauseOnThrottle` in the start/rerun bodies → `startCampaign`.
- `public/index.html`, `public/js/app.js`, `public/css/style.css` — B1 disclaimer + B2
  toggle (Campaign Settings / Throughput → "Advanced · pause between leads" area); carry
  `pauseOnThrottle` in the start payload; surface the disclaimer on rerun.
- Tests — `classifyConnectFailure` (every branch incl. real strings from the logs:
  `VOYAGER_REJECTED: HTTP 429`, `No modal appeared`, `WEEKLY_LIMIT`); jittered backoff
  (bounded in `[0, capped]`, grows with streak).

## Error handling / UX

- `challenge` → account halted, clear status ("LinkedIn checkpoint — needs a human"),
  surfaced; never auto-cleared.
- `invite_cap` → account stops sending this cycle, monitoring continues; status says so.
- `throttle` + toggle on → account paused with backoff, resumes slower; others run.
- `transient` → at most 1–2 guarded resets; then the existing skip/park.

## Back-compat

- `pauseOnThrottle` defaults ON; older saved campaigns without it → ON on load.
- about:blank reset is additive to the retry paths; the verdict logic is unchanged.
- No off-limits files touched; outreach/actions results are read, not modified.

## Open questions for review

1. **Connect-retry re-verify cost:** re-running the full gate on a transient retry adds a
   navigation. Acceptable (it's only on the retry path, capped 1–2)? (Recommend yes —
   correctness/safety over speed on the rare retry.)
2. **`transient` includes "No modal appeared"** — that's the dominant skip in the logs.
   Reset-and-retry once before skipping (recommended) vs leave as immediate skip?
