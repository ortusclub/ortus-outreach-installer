# Campaign Waiting state — tell the operator the truth about why nothing is sending

**Date:** 2026-08-19
**Status:** Spec B of two. Spec A (monitor reliability) is merged to engine `main` @ `a233885`.
**Spans TWO repos:** engine `ortus-salesnav-scraper-cloud` + app `ortus-gologin-clone`.
**Scope:** Cloud campaigns only. Local (`src/campaign.js`) campaigns keep today's behaviour.

---

## Why

Colleagues report that campaigns "start after days because everything is too filled".

Measured 2026-08-19, that premise is false and the real cause is different:

- Pod ceiling is **30** concurrent campaigns (6 x 5). Peak ever is **4 pods**. `queue: []`.
  Across 109 campaigns, **none has ever waited for a slot.**
- What they are actually waiting for is **LinkedIn accounts**. 13 accounts sit weekly-capped
  with ~4.4 days left (`cmp:park:*` = `weekly`, TTL 383,786s). Rein's running campaign had 3 of
  5 accounts parked; Qendresa's had 4 of 5.

A campaign in that state shows **Running** and sends nothing. To an operator that is
indistinguishable from a system that is full. It is not full — it is out of accounts, and
nothing in the product says so.

### The second, smaller problem

`_maybeSleepCampaign` computes the true unblock time correctly and then throws most of it away:

```js
const until = new Date(Date.now() + Math.min(secs, BLOCK_CAP_SEC) * 1000);  // BLOCK_CAP_SEC = 6h
```

A 4.4-day weekly park can therefore only ever sleep 6 hours. The campaign wakes, spins up a pod,
re-discovers the same 4-day wall, and sleeps again — roughly **4 wakes/day for 4.4 days**.

This is worth ~$4/month, not more. It is in this spec because it is two lines and because the
wake-up text is wrong either way — **not** because the cost matters.

---

## What already exists (do not rebuild)

Read this before designing anything. Two of the four pieces are already built.

**The app already renders a Waiting state** — `public/js/app.js:7684-7693`, inside
`_cloudCurrentAction`:

```js
return { phase: 'waiting', label: 'Waiting for a free account',
  account: '', lead: 'No account free',
  sub: `${why || 'every account is at a limit or benched'} · the VM stands down until ${when} to save cost, then picks itself back up` };
```

**The engine already sleeps correctly apart from the clamp** — `campaign-worker.js`
`_earliestUnblockSec` mirrors the selection loop's precedence exactly and returns 0 as soon as one
account is usable, so a campaign with any free account never sleeps. That logic is right; only the
clamp on its result is wrong.

**The monitoring invariant is already guarded** — `test-monitor-survives-block.js` (shipped in
Spec A) pins that `blocked_until` gates the STATUS arm of `refreshScaleMetric` but never the TASK
arm. That test must keep passing; it is what stops this spec accidentally silencing acceptance
checks for a capped campaign.

So this spec is smaller than it looks: **fix a formatter, delete a clamp, add per-account reasons,
add a start-time prompt.**

---

## THE LOAD-BEARING COUPLING — read this first

`when` in the existing card is built with:

```js
new Date(wake).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
```

**Hour and minute only. No date.** That is safe *only* because `BLOCK_CAP_SEC` guarantees the wake
is within 6 hours. Remove the clamp and a weekly park renders as **"the VM stands down until 23:59"**
when it means **Saturday** 23:59, four days out.

**Deleting the clamp without fixing this formatter makes the product lie more than it does today.**
The two changes must ship in the same task. This is stated here because it is exactly the kind of
coupling that a task-scoped reviewer cannot see.

---

## Global Constraints

- **Monitoring must keep running the whole time.** `blocked_until` gates SENDING only. Weekly cap /
  429 / daily limit / note credits do NOT stop monitoring — a capped account can still RECEIVE
  acceptances. Only proxy park, needs-login and the busy lock skip an account in a sweep.
  `test-monitor-survives-block.js` must keep passing.
- **No new campaign status.** Waiting is DERIVED at render from `status === 'running' && blocked_until > now`.
  51 sites test `status === 'running'`; a new status means auditing all of them.
- **No schema change.** `blocked_until` already exists. No `blocked_reason` column — the always-on
  frontend can read live Redis TTLs on demand, so storing a reason would be a second source of truth
  that can go stale.
- Engine: Node >= 22, standalone `test-*.js` run individually with `node <file>.js`, `node:test` +
  `node:assert/strict`. No `npm test`, no `--test-force-exit`, no `timeout` wrapper (macOS).
- App: vanilla HTML/CSS/JS, no bundler, no framework. Bugatti command-deck design system —
  monochrome, hairlines, gold ONLY on the Start CTA, radii 0 or 9999, no other accent colours.
- App has no test suite. UI changes are verified manually via `npm run dev:app`.
- Patch-bump `package.json` and both `index.html` `?v=` before any relaunch.
- `deploy.sh` does not apply k8s manifests. This spec adds none.
- Off-limits: `src/linkedin/outreach.js`, `src/linkedin/actions.js`. Nothing here needs them.

---

## Design

### 1. Engine — `GET /api/campaign/preflight?profiles=a,b,c`

Returns, per profile id, why it cannot send and when it could:

```json
{ "accounts": [
    { "id": "68a53e86…", "reason": "weekly",    "until": "2026-08-23T23:59:00Z", "fixable": false },
    { "id": "697c157d…", "reason": "proxy",     "until": "2026-08-20T08:00:00Z", "fixable": true  },
    { "id": "68e4d028…", "reason": "needslogin","until": null,                   "fixable": true  },
    { "id": "68b53441…", "reason": "",          "until": null,                   "fixable": false }
  ],
  "usable": 1, "earliest": "2026-08-23T23:59:00Z" }
```

- `reason` from the `cmp:park:*` VALUE (`weekly` / `proxy` / `throttle` / `session`), plus
  `needslogin` from `cmp:needslogin:*` and `dailycap` from the daily counter.
- `until` from the real Redis TTL. `null` where there is no clock (needs-login is not a wait, it is
  a task for a human).
- **`fixable` is the field that matters.** `proxy` and `needslogin` clear in a minute of operator
  work. `weekly` cannot be fixed at all — there is nothing to do but wait. Today both surface
  identically, as a dead campaign, which is why operators cannot tell "act now" from "come back
  Saturday".
- Route MUST be registered **above** `/api/campaign/:id`, or Express reads "preflight" as an id.
  Same trap `worker-busy` and `capacity` already document.

One endpoint serves both surfaces: the modal asks about a candidate account set, the card asks about
a running campaign's set. Same question.

### 2. Engine — sleep to the real unblock time

`campaign-worker.js`: delete `Math.min(secs, BLOCK_CAP_SEC)`; keep `BLOCK_FLOOR_SEC` (30 min).

The floor earns its place and must stay — its comment records a real bug where a 30-minute session
bench never slept because the comparison was `>` rather than `>=`, so a campaign woke every half
hour all night to rediscover the same logged-out account.

**Early wake** (all three, per operator decision) — each calls `clearCampaignBlocked(id)`:

| Trigger | Hook |
|---|---|
| Operator clears an account (Retry / re-login / proxy fixed) | `unbenchAccount` (`campaign-store.js:810`) already DELs `cmp:weeklycap`, `cmp:park`, `cmp:429`, `cmp:proxy`, `cmp:needslogin` — add the campaign unblock beside it |
| Accounts added to the campaign | the campaign-edit route |
| Reality beat the estimate | always-on frontend, every 15 min: recompute earliest from live TTLs |

The 15-minute re-check may **only pull the wake-up in, never push it out**. Pushing out on a stale
read would let a transient Redis hiccup extend an operator's wait.

### 3. App — the Waiting card, two clocks

Amend the existing `_cloudCurrentAction` branch. Three changes:

**(a) Date-aware wake formatting — REQUIRED, see the coupling section.** Same day → `"14:30"`.
Different day → `"Sat 23 Aug, 23:59"`. Never a bare time for a wake more than ~12h out.

**(b) Real reasons, from preflight, not from log-scraping.** `why` currently comes from parsing the
monitor log, which the engine's own comment says goes stale within 15 minutes. Replace with the
preflight call: *"5 accounts capped until Sat 23 Aug"*, or when mixed, name the fixable ones first:
*"1 account needs re-login, 4 capped until Sat 23 Aug"*.

**(c) The second clock.** The card must say monitoring is still alive, because it is:

> **Not sending** — 5 accounts capped until Sat 23 Aug
> Still checking acceptances hourly · next check 14:12

Without this an operator reads Waiting as "stopped" and may cancel a campaign that is still
collecting acceptances and firing intros. `next_check_at` is already on the card
(`app.js:3927 showWaiting`).

### 4. App — refuse-modal at Start

When preflight returns `usable: 0`, intercept Start:

- Title: **"Nothing can send yet"**
- Names every account, splitting fixable (proxy, re-login) from just-wait (weekly cap).
- States the monitoring truth explicitly: acceptance checking still runs on the capped accounts.
- Buttons: **Back** / **Start anyway** / **Fix accounts**. Three, because "start anyway" is
  legitimate here — the leads send themselves when the cap lifts — and forcing a single path is what
  makes prompts hated.

Sketch: `public/sketches/2026-08-19-waiting-state-variants.html` (variant B).

**Known limitation, accepted:** this fires at Start, after the accounts were chosen two steps
earlier. The picker-warning variant (C in the sketch) prevents the bad set instead of reporting it,
and was explicitly deprioritised by the operator. Neither covers the common case — accounts capping
*mid-run*, days after anyone last opened the picker — which is what the Waiting card is for.

---

## Error handling

Every failure leaves the campaign **more** active, never less:

- Preflight unreachable at Start → modal does not block; the campaign starts.
- Preflight unreachable on the card → fall back to today's text (bare `blocked_until`), never a
  crash and never a blank card.
- `clearCampaignBlocked` fails → campaign stays asleep until its own timer. Worst case is the
  15-minute re-check, not 4 days.
- Nothing here may touch campaign `status`, and nothing may gate the scheduler or the task arm of
  `refreshScaleMetric`.

---

## Testing

**Engine** (standalone `node test-*.js`):

`test-campaign-sleep-real-ttl.js`
- A 4.4-day weekly park sleeps ~4.4 days, NOT 6h (the clamp is gone).
- A 20-minute block does NOT sleep (below `BLOCK_FLOOR_SEC`).
- A 30-minute bench DOES sleep (`>=`, not `>` — the regression its comment records).
- One usable account → `_earliestUnblockSec` returns 0 → no sleep, regardless of the others.

`test-campaign-preflight.js`
- Reason + `until` per account, read from real TTLs.
- `fixable` true for proxy/needslogin, false for weekly.
- `usable` counts only genuinely-free accounts.
- Route ordering: `/api/campaign/preflight` resolves before `/api/campaign/:id`.
- Errors 500 rather than inventing an empty account list.

`test-campaign-unblock-hooks.js`
- `unbenchAccount` clears the owning campaign's `blocked_until`.
- The 15-min re-check pulls a wake-up IN when reality beat the estimate.
- The 15-min re-check NEVER pushes a wake-up OUT.

**Regression:** `test-monitor-survives-block.js` must keep passing — a Waiting campaign still sweeps.

**App:** no test suite. Manual via `npm run dev:app`. The one check that must not be skipped:
force a `blocked_until` several days out and confirm the card shows **a date**, not a bare time.
That is the failure this spec exists to prevent introducing.

---

## Files

| Repo | File | Change |
|---|---|---|
| engine | `campaign-worker.js` | delete the `BLOCK_CAP_SEC` clamp; keep `BLOCK_FLOOR_SEC` |
| engine | `campaign-api.js` | `GET /api/campaign/preflight`, above `/:id` |
| engine | `campaign-store.js` | unblock beside `unbenchAccount:810`; preflight reads |
| engine | `server.js` | 15-min re-check in the scale bridge |
| app | `public/js/app.js` | date-aware wake format; preflight-sourced reasons; second clock; Start modal |
| app | `public/css/style.css` | Waiting tokens (grey, NOT red — a cap is not a fault) |

---

## Out of scope

- Local (`src/campaign.js`) monitoring and sleeping. Cloud only, per decision.
- The account-picker warning (variant C) — deprioritised.
- `pushed 0, failed 200` — every sheet write in one monitor sweep failed. Unexplained, still open,
  unrelated to this.
- Pod capacity, KEDA, `cooldownPeriod`. Measured as not the constraint; `cooldownPeriod: 90` is
  already committed on engine `main` and deliberately NOT applied to prod.
- Account supply itself. 13 weekly-capped accounts is a LinkedIn limit and a resourcing question.
  **This spec makes the wait legible. It does not make it shorter, and nothing in software can.**
