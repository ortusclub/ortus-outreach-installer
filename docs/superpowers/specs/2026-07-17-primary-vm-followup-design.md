# Primary Follow-up on the VM (Cookie Handoff) — Design

**Date:** 2026-07-17
**Status:** Draft — awaiting Antonio's review
**Scope:** App (`ortus-gologin-clone`) + cloud engine (`ortus-salesnav-scraper-cloud`)

## Problem

CC+IC campaigns run on the VM, but two primary-side actions still open the
LOCAL browser as a workaround: auto-accept of the primary's incoming
connection, and the auto follow-up sent AS the primary. Auto-accept locally is
acceptable; the follow-up must move to the VM so the whole chain runs
unattended.

Primaries are the team's PERSONAL LinkedIn accounts. They must never be added
to the shared GoLogin workspace (everyone would see and be able to open them).
Scale target: 60–80 distinct primaries; ~10 campaigns in parallel; the same
person can be the primary of several campaigns at once (e.g. Antonio on 3).
The engine must never act as the wrong person.

## Decision summary

| Decision | Choice |
|---|---|
| How the VM gets the primary's session | **Cookie handoff** from the local handshake login the primary already does on their own machine. No passwords stored, no GoLogin, no new ritual. |
| Identity key | LinkedIn **member ID** (never name, never campaign). |
| Same primary on N campaigns | ONE session/profile per person; follow-up jobs from all their campaigns queue on a **per-primary lock** — one browser at a time. |
| Wrong-identity protection | **Identity gate before every send**: engine loads the session, fetches the logged-in `/me`, compares member ID to the campaign's expected primary. Mismatch → hard stop, nothing sent (same philosophy as the v2.96.0 connect gate). |
| Dead session (expiry / checkpoint) | Follow-up jobs **park** (never fail, never mis-send). Surfaced as "Needs login"; re-login locally re-ships cookies and parked jobs resume. |
| Datacenter-IP checkpoint risk | **Posture 1 — accept + observe.** No residential proxies at launch. Failure mode is safe (park + re-login), so measure checkpoint frequency in reality before paying for 60–80 proxies. Add proxies later only if checkpoints prove frequent. |
| Trust boundary | Cookies live ONLY in engine storage; never rendered in any UI; nobody can "open" a primary profile from the team app. Engine admin is the boundary — the store must stay locked down. |

## Architecture

### 1. Cookie capture (app side, local)

The handshake browser is already app-controlled. After the primary logs in /
auto-accept runs, the app reads the LinkedIn session cookies (li_at + the
rest of the linkedin.com cookie jar) via CDP and POSTs them to the engine's
authed API. This happens silently on EVERY local handshake session, so
cookies stay fresh without anyone thinking about it.

- Endpoint: `POST /api/primaries/:memberId/session` (engine, Bearer-authed
  like every other engine call).
- Payload: cookie jar + captured-at timestamp + the member ID and display
  name read from the logged-in session itself (NOT typed by anyone).
- The app never persists the cookie jar to local disk; capture → ship →
  forget.

### 2. Primary registry (engine side)

One record per primary, keyed by member ID:

```
primaries/<memberId>/
  cookies.json        (the shipped jar + capturedAt)
  profile/            (persistent Chromium user-data-dir)
  state               (live | needs_login)
```

Storage must survive pod restarts (volume or bucket — GKE pods are
ephemeral; this is a hard requirement, not an optimization). Campaign records
store `primaryMemberId` only.

### 3. Follow-up execution (engine side)

Campaign flow is UNCHANGED until the follow-up moment: checks at the
1/2/3/6-hour marks find the accepted connection; the GoLogin account sends
the intro message on the VM as today; the campaign's configured delay
(10/20/30 min) elapses. Then, instead of the app opening a local browser:

1. Engine enqueues a follow-up job tagged `primaryMemberId` on the existing
   dueAt task queue.
2. Worker takes the **per-primary lock** (Antonio's 3 campaigns = 3 jobs
   queued on one identity, executed one at a time; never 3 parallel browsers
   on one account).
3. Worker launches Chromium with `primaries/<memberId>/profile` + injected
   cookies.
4. **Identity gate:** fetch logged-in `/me`; member ID must equal the job's
   `primaryMemberId`. Mismatch or not-logged-in → do NOT send; park the job;
   set state `needs_login` (on mismatch also log loudly — that's a registry
   bug, not just expiry).
5. Send the follow-up in the existing thread as the primary. Existing
   write-back (sheet/log) unchanged.

### 4. Parking + resume

- A job that can't run (dead session) parks with a reason; it is never
  dropped and never retried into a wrong identity.
- When fresh cookies arrive for that member ID (`POST .../session`), state
  returns to `live` and parked jobs for that primary become due immediately.

## "Needs login" surfacing — one source, four surfaces

**Single source of truth:** the engine campaign-status payload (already
polled every 5 s by the dashboard) carries
`primarySession: live | needs_login` + the primary's display name. Every
surface reads this same field; the creation tab additionally does one
registry lookup when a primary is picked.

1. **Dashboard strips.** Every strip whose campaign's primary session is
   dead gets a red badge: `⚠ Primary needs login — Antonio`. Deliberately
   repeated on ALL of that person's strips — each campaign genuinely
   blocked, and someone scanning 10 strips must see which. Live sessions
   show nothing (no green noise).
2. **Campaign-tab live status card** (card #2, the `renderActiveCard` one).
   Banner + parked count: `3 follow-ups parked — waiting for Antonio to log
   in`. The card is where "why isn't this moving" gets asked, so the answer
   lives there.
3. **Campaign creation tab.** When a primary is picked, the wizard shows the
   registry state: green `Session live — synced 2h ago` or red `Needs login
   — follow-ups will park until Antonio logs in locally`. Warning, NOT a
   blocker: connects/intros don't need the primary session; only follow-ups
   park.
4. **Personal nudge on the primary's own machine.** The person who must ACT
   may not be the one watching the dashboard. When the app opens on a
   machine whose operator's own member ID has a dead session: top-level
   banner `Your LinkedIn session expired — log in to release 3 parked
   follow-ups`, one click opens the handshake browser.

## Error handling

- **Cookie ship fails (network/engine down):** local handshake completes as
  today; app retries the ship with the standard transient-retry pattern;
  a lost ship only means the VM session goes stale later — parked, never
  wrong.
- **Checkpoint mid-send:** treated as dead session → park + `needs_login`.
- **Identity-gate mismatch:** hard stop + loud log + park. Never "best
  effort".
- **Pod death mid-follow-up:** job returns to queue (existing dueAt
  semantics); per-primary lock released; profile persisted.

## Explicitly out of scope

- Residential proxies per primary (posture 2) — only if observed checkpoint
  frequency demands it.
- Storing passwords or any credential-based VM login — rejected outright.
- Remote interactive login on the VM (option B) — unnecessary: every
  primary already does the local handshake login on their own machine.
- Moving auto-ACCEPT to the VM — the local workaround for accepting stays.

## Success criteria

1. A CC+IC campaign with a non-GoLogin primary completes intro + follow-up
   entirely on the VM with the primary's laptop closed.
2. Same primary on 3 campaigns: follow-ups execute serially under one
   session; zero cross-identity sends (gate verified in logs).
3. Killing the primary's cookies mid-campaign → follow-ups park, all four
   surfaces show "Needs login", re-login locally resumes and sends them.
4. No plaintext credential ever exists in either repo, any store, or any log.
