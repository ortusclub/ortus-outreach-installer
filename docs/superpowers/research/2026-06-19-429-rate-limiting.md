# Research: HTTP 429 & LinkedIn rate limiting — implications for Ortus Outreach

**Date:** 2026-06-19
**Why:** before building the retry/skip/interval hardening (fix "B"), research 429
handling in depth. Triggered by the HTECH campaign 429 storm + "skipping too much"
+ operators setting inter-lead intervals to 10–20s.

## The single most important finding: there are TWO different limits

The app currently blurs these; they need different reactions.

| | **Request-rate 429** (Voyager "Resource level throttle") | **Invite cap** ("weekly invitation limit") |
|---|---|---|
| Trigger | too many *requests* too fast | invite *quota* spent (~100/week, rolling 7-day) |
| LinkedIn msg | "Resource level throttle limit … reached" | "You've reached the weekly invitation limit" |
| Duration | auto-recovers, minutes–hours | ~1 week (rolling window bleeds back in) |
| Correct reaction | **back off + slow down**, retry later | **STOP sending invites on that account** — retrying is counterproductive and manufactures more 429s/challenges |
| Retry-After header | LinkedIn usually does **not** send one → fall back to backoff | n/a |

Both appeared in our logs (`VOYAGER_REJECTED: HTTP 429` *and* `LINKEDIN CAP·INVITES`).
Treating the invite cap like a transient 429 (retry/keep going) is what pushes an
account up the escalation ladder.

## Escalation ladder (push past limits)

429 throttle (auto-recovers) → invite cap (~1wk) → **security checkpoint/challenge**
(human must clear; new accounts hit this far more) → **temporary restriction**
(~1 week, official) → **permanent ban** (from *repeated* restrictions). Key insight:
a temporary restriction is a warning shot; tools that pause recover, tools that keep
hammering escalate. **On a challenge/checkpoint: halt the session, surface to a
human — never auto-retry through it.**

## Safe pacing numbers (vendor/community consensus — LinkedIn publishes none)

- **Between actions: 30–120s, randomized.** Fixed-interval cadence is itself a
  detection signal. → **Operators' 10–20s is squarely in the danger zone.**
- **Per account/day:** new 5–10, warming 10–15, warmed 20–25 (aggressive up to ~50,
  risk zone). Our `dailyLimit` default **50** is at the aggressive end.
- **Voyager read ceiling ≈ 900 contiguous requests/hour** (community-observed).
- New vs aged is the biggest differentiator; new accounts need a 4-week warmup ramp.
- Keep pending invites < ~500; withdraw invites older than ~3 weeks (low acceptance /
  many-pending is an explicit LinkedIn restriction trigger).

## Retry reset: is "about:blank → re-goto" sound? **Yes, but guarded.**

- `page.goto(sameURL)` on an SPA can silently become a **no-op** (same-URL/hash →
  no document teardown, no load event) — so the wedged/cached state is *never*
  cleared. This confirms our current gate retry doesn't truly reset.
- `about:blank → goto(target)` forces a real document teardown the SPA router can't
  collapse, **while preserving cookies/session** (blank page has no origin). It's the
  community-standard page reset.
- Caveats: it does **not** clear HTTP cache (pair with cache-disable if needed), and
  it won't revive a crashed renderer (escalate to new page → new browser).
- **It is a render reset, not a throttle reset.** Looping about:blank→goto against a
  throttled endpoint is still hammering.

### The decision rule (classify before reacting)

```
After navigation, classify the landed page:
  1. invite-cap text         → STOP this account this cycle (no retry)
  2. 429 / soft-block / challenge → session-level backoff/pause (circuit breaker);
                                    honor Retry-After if present, else jittered backoff
  3. transient render glitch  → about:blank → goto(target) → waitForSelector(topcard)
                                + RE-RUN identity gate (keep wrong-person safeguard),
                                capped 1–2 attempts, jittered backoff
  4. still failing            → fresh page in same context (session intact)
```

## Backoff algorithm

Full jitter: `sleep = random(0, min(cap, base * 2**attempt))`, `base=1s`, `cap≈30–60s`,
honor `Retry-After` when present (`wait = max(Retry-After, jittered)`). Jitter is
both anti-thundering-herd **and** anti-detection (deterministic backoff is a
fingerprint). Cap retries by count AND elapsed time. Retry at one layer only.

## `waitUntil` for SPAs

Use `domcontentloaded` + an explicit `waitForSelector` on a good-render marker (the
profile top-card) as the real "did it load correctly" check. **Avoid `networkidle`** —
it hangs on LinkedIn (websockets/analytics/service workers) and worse on backgrounded/
throttled tabs. Never `timeout: 0`.

## How this refines fix "B"

1. **Classify 429 vs invite-cap vs render-glitch** (not one "rate_limited" skip).
   Invite-cap → stop the account for the cycle. 429/challenge → session circuit breaker.
2. **Retry = about:blank → re-goto → re-run identity gate**, guarded by the classifier,
   capped 1–2 attempts with jittered backoff. (Implementable in `campaign.js`: it owns
   the gate + retry loop + can issue the blank nav; reads the 429/cap signals that
   `outreach.js`/`actions.js` already surface — no edits to those off-limits files.)
3. **Inter-lead delay floor ≥ 30s, randomized 30–120s band**, enforced on live config
   AND reruns/saved settings (an old 10s config can't sneak back). Matches the app's
   own 30–60 default and vendor consensus.
4. **Session circuit breaker** on clustered 429/soft-block → pause the account (the
   existing `weeklyLimited`/parking + `degradationBackoffMs` scaffolding is the home;
   add jitter + proper 429/cap classification). Surface challenges to a human.
5. (Product, later) reconsider `dailyLimit` default (50 → aggressive) and a warmup ramp.

## Sources (most authoritative first)

- RFC 6585 §4 (429 semantics); MDN `Retry-After`.
- LinkedIn API docs (learn.microsoft.com/linkedin): rate-limits (app/member throttle,
  midnight-UTC reset, "Standard rate limits are not published"), error-handling
  ("Resource level throttle limit … reached", "infrastructure protection").
- LinkedIn Help: "Invitation limit reached" (~1 week), "Types of restrictions for
  sending invitations" (triggers; 3-week re-invite cooldown; up to 1 month).
- AWS Architecture Blog "Exponential Backoff And Jitter" (Full/Equal/Decorrelated
  formulas); AWS Well-Architected REL05-BP03 (cap retries; idempotency; one layer).
- Microsoft Azure "Circuit Breaker pattern" (closed/open/half-open).
- Puppeteer issues #257/#10405 (same-URL goto no-op), puppeteer-cluster #241
  (about:blank reset), pptr reload/setCacheEnabled docs.
- browserless / AppSignal / Biome (waitUntil tradeoffs; networkidle discouraged).
- linkedin-api (PyPI) ~900 req/hr Voyager ceiling; Linked Helper / Kondo / Dux-Soup /
  Closely / Expandi (daily/weekly ranges, warmup, escalation) — vendor estimates.
