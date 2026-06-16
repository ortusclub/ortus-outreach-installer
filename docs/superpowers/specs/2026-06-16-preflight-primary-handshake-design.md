# Pre-flight Primary Handshake — Design Spec

**Date:** 2026-06-16
**Status:** Approved design, ready for implementation plan
**Author:** brainstormed with Antonio

## Goal

Make the primary auto-accept **timely and predictable**: complete the account↔primary
connection links *before* lead outreach begins, instead of waiting for the app to go
fully idle (the current behaviour, which can leave links unaccepted for hours/days on a
busy or monitoring app).

## Problem (today)

The account↔primary link is a prerequisite for the 3-way intro: a campaign account can
only introduce a lead to the primary once it is connected to the primary. Today:

- The connect-to-primary request is sent lazily on each account's **first turn** inside
  the lead rotation (`src/campaign.js` `runProfileTurn`, lines 2738–2794).
- The **acceptance** is deferred to the idle runner (`src/primary-task-runner.js`), which
  only fires when `shouldRun = !campaignRunning && browserCount === 0` on a 60s tick.

On a busy app (long campaign, back-to-back queue, continuous monitoring opening browsers)
the idle window is rare, so acceptances pile up and intros stall.

## Solution overview

A deterministic **pre-flight handshake** that runs once at campaign start, *before* the
lead rotation, for the CC+IC flow. It front-loads the connect-to-primary sends, then
opens the primary **alone** to accept them, then starts outreach. It is **best-effort and
never blocks** — anything not completed in a bounded window falls back to today's idle
queue.

It is **self-eliminating**: accounts already connected to the primary are skipped, so on
repeat campaigns the pre-flight is a no-op and outreach starts immediately.

## Scope & triggering conditions

Pre-flight runs at campaign start when **all** of:

1. `mode` is `connect_and_introduce` (CC+IC) — the only flow that sends connect-to-primary
   requests. The in-loop primary gate at `runProfileTurn` (`campaign.js:2738`) is
   `connect_and_introduce`-only; `introduce_back` (IC) does not send connect requests
   (its leads are already connections and the intro is name-based), so pre-flight does not
   apply to it — see Non-goals.
2. `templates.primaryUrl` is set (and structurally valid — see the v2.104 primary-URL
   hard-lock, already enforced at start).
3. `templates.autoAcceptPrimary` is **on** (we need a primary identity/browser to accept
   with; `templates.primarySource` names it — `'local-browser'` or a GoLogin profileId).

If auto-accept is **off**, behaviour is unchanged: connect-to-primary happens in-loop as
today and acceptance is manual. Pre-flight is gated entirely behind the existing
auto-accept toggle — no new opt-in surface.

## The three phases

```
PHASE 0 — Send (sequential, one browser at a time)
  for each participating account (non-local) NOT already connected to the primary:
    open → checkAndConnectPrimary (send ONE connect request) → close
  already-connected accounts are skipped and marked.

PHASE 0.5 — Accept (the primary, alone)
  open the primary (local browser OR its GoLogin profile, per templates.primarySource)
  → accept every matching sender invitation that has landed
  → if fewer than expected are visible, refresh every ~30s up to a 2-min cap,
     accepting as they appear
  → close.

PHASE 1 — Outreach
  the normal campaign lead rotation, now with account↔primary links in place.
```

### Timing

- Phase 0's sequential sends give natural propagation time: by the time the last account
  sends and the primary opens, the early invitations are already minutes old.
- Phase 0.5 accepts what is visible immediately; only the freshest 1–2 invitations may
  need the bounded poll. **Poll cap: ~2 minutes**, refresh interval ~30s.
- Whatever has not surfaced by the cap → left to the idle queue (below). Outreach starts.

### Fallback (never blocks the campaign)

- Any account not accepted within the window keeps its accept task in the **existing**
  `primary-tasks.json` idle queue (today's `buildAcceptTask` / `enqueuePrimaryTask` path),
  drained by `primary-task-runner.js` at the next idle moment.
- If the primary cannot be opened at all (not logged in / profile down): skip Phase 0.5
  entirely, leave all accepts queued, log a clear warning, proceed to Phase 1.
- This preserves graceful degradation and avoids the "campaign won't start on a bad
  session" failure mode we removed earlier.

### Accept confirmation modal ("Take care when connecting") — REQUIRED

After clicking a card's **Accept**, LinkedIn sometimes (varies by account/relationship —
typically cold / high-mutual invitations) shows a **"Take care when connecting"** modal:

> "For your safety, we recommend you only connect with people you know and trust."
> [ View profile ] [ **Accept invite** ]

**The invitation is NOT actually accepted until "Accept invite" is clicked.** Today's
`acceptInvitationFrom` (`src/linkedin/accept-invitation.js`) clicks the card Accept and
stops, so on these accounts the invite silently stays pending — a real current gap.

Required behaviour: after the initial Accept click, `acceptInvitationFrom` must detect this
modal and click its **Accept invite** confirmation, then settle. Constraints:

- **Locale-aware:** match the confirm button by accept-stem (reuse `isAcceptLabel` /
  `ACCEPT_STEMS`), the same way the card button is matched — never hard-code "Accept invite".
- **Scoped to the dialog:** query within the modal (`[role="dialog"]` / artdeco modal
  container) so we click the confirm, never a card's Accept underneath, **View profile**,
  or the close **X**.
- **Optional:** the modal doesn't always appear — if no dialog surfaces within a short wait
  (~2s), treat the accept as complete and move on (don't hang).
- This is a **DOM (React) modal, not a native `window.confirm`** — safe to click via
  Puppeteer.

Because pre-flight Phase 0.5 and the idle `primary-task-runner` both call
`acceptInvitationFrom`, this is a **single shared fix** benefiting both paths.

## Wiring (first-class concern — must be linked to the campaign lifecycle)

This feature reuses the existing primary-connection machinery; it is a **reordering +
an immediate-accept step**, not a parallel subsystem.

### Orchestration insertion point — `src/campaign.js`, inside `startCampaign`

- After the rotation is seeded (`const profileQueue = [...profileIds]`, ~line 2669) and
  the per-turn helpers are defined, but **before** the worker rotation that drives
  `runProfileTurn` begins.
- Implemented as a new awaited step `await runPreflightHandshake(...)` that:
  - **Phase 0:** iterates `participatingProfileIds` (non-`local-browser`), and for each
    not-yet-`'connected'` account calls the **same** `checkAndConnectPrimary(page, primaryUrl, …)`
    used at line 2751, writing per-account state into `campaign._primaryConn` via
    `primaryConnState(...)` — identical to the current in-loop write at 2758.
  - On a `connectResult === 'sent'`, captures the account identity with `readSelfIdentity(page)`
    and **builds** the accept task (`buildAcceptTask`) exactly as the current block
    (2762–2791) — but holds it for Phase 0.5 rather than only enqueuing for idle.
  - **Phase 0.5:** launches the primary via `launchLocalBrowser()` (local-launcher.js) or
    `launchProfile(profileId, token)` (gologin-launcher.js) per `templates.primarySource`,
    routed through `browserSemaphore.acquire()/release()` (same discipline as the runner),
    and calls `acceptInvitationFrom(page, account, { log })` (accept-invitation.js) for each
    queued account, polling/refreshing up to the cap.
  - Any account not accepted → `enqueuePrimaryTask(buildAcceptTask(...))` for the idle
    fallback (the current path).

### Fallback composition with the existing in-loop check

- The in-`runProfileTurn` primary block (2738–2794) is **left in place** as the safety
  net. Its existing guard `if (_prev !== 'connected')` (2749) makes it a **no-op** for
  accounts pre-flight already connected. For anything pre-flight skipped or missed (e.g.,
  an account that joins the rotation later), it behaves exactly as today.

### Status producer — `getCampaignStatus()` (`src/campaign.js:4547`)

- Add a `phase` field: `phase: campaign.phase || null` (values: `'preflight'` during the
  handshake, `null` otherwise). `state`/`running` are unchanged (`running` stays `true`
  through pre-flight; pre-flight is a sub-phase of a running campaign).
- `primaryConn` (already exposed, from `campaign._primaryConn`) is reused for the
  per-account checklist. Extend its value vocabulary for the handshake states below.

### Status consumer — `renderActiveCard(s)` (`public/js/app.js`)

- Add a branch mirroring the existing `is-monitor` handling (`__cockpit.state === 'monitoring'`):
  when `s.phase === 'preflight'`, toggle `is-preflight` on the `#active-card` and render the
  checklist + live beat from `s.primaryConn` + `s.profileNames`.
- `buildLiveActivity(status)` (`/js/live-activity.mjs`) gains a pre-flight beat
  ("Primary accepting — <account>", "X of N done…").
- When `phase` clears, the card drops `is-preflight` and renders the normal running state —
  the morph-into-running behaviour. No second card is created/destroyed.

### Off-limits — untouched

`src/linkedin/outreach.js` and `src/linkedin/actions.js` are **not** modified.

## Data model

`campaign.phase`: `'preflight' | null` (new). Set at the start of `runPreflightHandshake`,
cleared in its `finally` before the rotation begins.

`campaign._primaryConn` (existing `Map<profileId, state>`), state vocabulary for the
handshake (superset of today's `'connected' | 'pending' | 'unverified' | 'no_url'`):

| state | meaning | checklist row |
|---|---|---|
| `already_connected` | skipped in Phase 0 | – already connected |
| `sent` / `pending` | request sent, awaiting accept | • waiting |
| `accepting` | primary is accepting it now | ↻ accepting |
| `connected` | accepted (link complete) | ✓ accepted by primary |
| `unverified` | degree unreadable (intros still proceed) | (neutral) |

(If reusing the exact existing strings is cleaner during implementation, the row mapping
is what matters — define the final set in the plan and keep producer + consumer in sync.)

## UI — Variant C (integrated)

Prototype: `public/sketches/preflight-visibility.html` (built 1:1 from the real `vj-card`).

- New **gold** card state `is-preflight` (alongside green `running`, blue `is-monitor`):
  gold left rail, gold eyebrow dot, gold progress-bar fill. Tokens only (`--gold`,
  `--green`, `--hairline`) — consistent with the Bugatti command-deck system.
- Eyebrow: `PRE-FLIGHT · PRIMARY HANDSHAKE`.
- `vj-live` beat line: "Primary accepting — <account>" + sub "X of N done · waiting up to
  2 min for the last to appear".
- `vj-hbar`: handshake progress = accepted ÷ (accounts needing connection).
- Per-account checklist (new `pf-list`/`pf-row` component) in the hero area, driven by
  `primaryConn`.
- The real live log (`#active-log`) streams the beats (🤝 Preparing introductions…,
  → requests sent, ✓ primary accepted <account>, ↻ accepting <account>…).
- On completion/timeout, `is-preflight` is removed and the card becomes the normal running
  card.

CSS lives in `public/css/dashboard-v0.3.css` next to the `.vj-card` / `is-monitor` rules.

## Error handling / safety

- **No concurrency:** Phase 0 opens one sender at a time; Phase 0.5 opens the primary
  alone. All browser opens go through `browserSemaphore` (≤ max). Respects the one-session-
  per-GoLogin-profile constraint and the "one campaign at a time" rule.
- **Precise accept:** reuses `acceptInvitationFrom` / `pickInvitation` (profile-URL or
  exact-name match only) — never accepts a stranger.
- **Degradation-safe:** bounded 2-min poll; primary-open failure → skip + idle fallback;
  identity-read failure for an account → skip its accept (queue for idle), continue.
- **Never blocks:** outreach always proceeds after the bounded window.

## Components & files

| Unit | Responsibility | Tested |
|---|---|---|
| `src/preflight-handshake.js` (new) | **Pure** planning + progress + timeout/fallback decisions: which accounts need connecting, accepted-vs-expected progress, "proceed now?" decision, checklist-state mapping. No Puppeteer. | `node --test` |
| `src/campaign.js` `runPreflightHandshake` (new, orchestration) | Wires the pure planner to the real browser helpers (`checkAndConnectPrimary`, `readSelfIdentity`, `acceptInvitationFrom`, `launchLocalBrowser`/`launchProfile`, `browserSemaphore`), updates `campaign.phase` + `campaign._primaryConn`, emits log beats. Inserted before the rotation. | manual + via pure unit |
| `src/linkedin/accept-invitation.js` `acceptInvitationFrom` | after the Accept click, detect + confirm the "Take care when connecting" modal ("Accept invite", locale-aware, scoped to the dialog, ~2s optional wait). Shared fix for pre-flight + idle runner. | pure label test + manual |
| `getCampaignStatus()` (`src/campaign.js`) | add `phase` field | existing status tests |
| `public/js/app.js` `renderActiveCard` + `/js/live-activity.mjs` | render `is-preflight` state + checklist from `phase` + `primaryConn` | manual |
| `public/index.html` (`#active-card`) | checklist container | manual |
| `public/css/dashboard-v0.3.css` | `is-preflight` gold state + `pf-list` styles | manual |

## Testing

- **Pure logic** (`src/preflight-handshake.js`) via `node --test`: planner skips
  already-connected; progress math; "proceed after cap / when all accepted"; checklist
  state mapping; empty/edge inputs.
- **Manual:** verify the gold pre-flight card renders, morphs into running, and the
  fallback line shows when an invite doesn't surface in time.

## Non-goals / out of scope

- **`introduce_back` (IC) is out of scope.** Its leads are already connections and the
  intro is name-based; it sends no connect-to-primary request (no in-loop gate), so there
  is nothing for the primary to accept. Revisit only if IC ever sends connect requests.
- No change to lead-side outreach, the bulk-acceptance check, or monitoring.
- No change when auto-accept is off.
- Not touching `outreach.js` / `actions.js`.
- The idle `primary-task-runner` stays exactly as-is — it is the fallback, not replaced.

## Decisions log

- **Best-effort, never block** (vs. wait-N / block-until-done): chosen — avoids the
  "won't start on a bad session" failure; intros have slack (leads accept days later).
- **~2-min bounded accept poll**: chosen — covers propagation lag for the freshest sends
  without stalling the start.
- **Variant C (integrated card)**: chosen over a dedicated card (B) / minimal state (A) —
  visible process without dashboard clutter; natural morph into running.
- **Gate on existing `autoAcceptPrimary`**: chosen — no new opt-in; off = unchanged.
