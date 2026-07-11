# Cloud primary-handshake — Path A (local pre-dispatch) design

**Date:** 2026-07-11
**Branch:** preflight-linter-2135
**Status:** Design — awaiting user review
**Supersedes-for-now:** the engine hard-lock in
`2026-07-10-cloud-primary-handshake-design.md` (that is "Path B"; it stays
specced + its app-half stays dormant until the engine ships).
**User decision:** "Both — A now, B later."

---

## Root cause (verified 2026-07-11, at every boundary)

On a cloud CC+IC campaign with a **local-only primary**, the sender→primary
connection **never happens**, so the primary (operator) receives no connection
request. Confirmed:

1. **Engine emits no `state`.** Live campaign `cmp_0ragg3szmrf49o5t`:
   `status: monitoring · mode: connect_and_introduce · state: undefined`. The
   app-half handshake (UI + one-time modal) triggers ONLY on
   `state === 'awaiting_primary_accept'`, which the engine never sends →
   **permanently dormant.**
2. **Engine has no upfront Phase-0 handshake.** Zero occurrences of
   `awaiting_primary_accept` / any sender→primary pre-step in the engine repo.
   The engine-side spec was a handoff doc, never built.
3. **Engine's only sender→primary connect is lazy.** It lives in
   `runAutoIntros` (`campaign-autointro.js`), which returns immediately unless a
   lead was just **accepted** (`connectedUrls` non-empty). The campaign is
   monitoring with **0 accepted** → the gate never runs → no connect-request to
   the primary is ever sent.
4. **The app does no handshake at cloud launch.** `start-cloud` builds the lead
   list and dispatches; no pre-step.

## Goal

When a cloud CC+IC campaign has `autoAcceptPrimary === true` and
`primarySource === 'local-browser'`, run the sender→primary handshake **locally,
on the Mac, before dispatching to the engine** — using the GoLogin sender
profiles (already required to be GoLogin for a cloud run) and the local primary
browser. Once the senders are connected to the primary, dispatch the campaign to
the VM; the engine's existing lazy gate re-checks, finds them already connected,
skips the connect, and sends intros normally as leads accept.

The "🤝 we're auto-accepting the connection" wizard the operator remembers
**actually fires** during this local step.

## Non-goals

- No engine change. Path A needs none.
- No edit to `src/campaign.js`, `src/linkedin/outreach.js`,
  `src/linkedin/actions.js`, `src/linkedin/accept-invitation.js`,
  `src/local-launcher.js`, `src/primary-task-runner.js`, `src/primary-tasks.js`.
  Path A **imports and calls** their exported primitives; it edits none of them.
- No removal of Path B. `hsAwaiting`, the handshake modal, and
  `signalPrimaryAcceptDone` / `/primary-accept-done` stay exactly as-is — dormant
  by construction (they key on the engine `state`). If the engine ever ships
  `awaiting_primary_accept`, Path B lights up automatically alongside Path A.

## Why local pre-dispatch is sound

GoLogin profiles carry their own proxy + fingerprint, so driving a sender profile
locally is equivalent to driving it on the VM (this is exactly how local
campaigns already work). The LinkedIn connection state is the single source of
truth: after the local handshake, each sender **is** a 1st-degree connection of
the primary, so the engine's `checkAndConnectPrimary` on the VM returns
`connected` (`connectAttempted: false`) and proceeds straight to the intro. No
duplicate request, no Mac involvement after dispatch. The campaign runs 100% on
the VM from then on — the handshake's whole point.

## Architecture

### New module: `src/cloud-preflight-handshake.js`

A standalone orchestrator that mirrors `runPreflightHandshake`'s flow but takes
explicit deps (no campaign-runner closure). It **calls only importable
primitives**:

- `planAccountsNeedingConnect` (`src/preflight-handshake.js`)
- `checkAndConnectPrimary` (`src/linkedin/primary-connection.js`)
- `readSelfIdentity`, `acceptInvitationFrom`, `acceptAllPendingInvitations`
  (`src/linkedin/accept-invitation.js`)
- `buildAcceptTask`, `enqueuePrimaryTask` (`src/primary-tasks.js`)
- `loadPrimaryStatus` / `savePrimaryStatus` (primary-status store)
- launchers: `launchProfile`/`closeProfile` (GoLogin senders),
  `launchLocalBrowser`/`closeLocalBrowser` (local primary)

**Signature:**
```
async function runCloudPreflightHandshake({
  senderProfileIds,     // string[] — GoLogin ids selected for the cloud run
  primaryUrl,           // string
  primarySource,        // 'local-browser' (Path A trigger)
  autoAcceptAllPending, // bool — honor the accept-all sweep toggle
  token,                // GoLogin token (for launchProfile)
  onProgress,           // (evt) => void — per-sender state for the wizard
}) => { ok, connected, accepted, pending, senders: [{ profileId, name, state }] }
```

**Flow** (self-eliminating like the local one):
1. Seed from the primary-status store; drop senders already `connected`.
2. If nothing needs connecting and accept-all is off → return `ok:true` (no-op).
3. For each remaining sender: `launchProfile` → `checkAndConnectPrimary(attemptConnect:true)`
   → `readSelfIdentity` → `buildAcceptTask` → `closeProfile`. Emit progress
   (`connecting` → `sent`).
4. Launch the local primary browser (`launchLocalBrowser`). Accept the queued
   invitations with the same cap/poll as `runPreflightHandshake`
   (CAP 120s, POLL 30s). Emit `accepting` → `connected`. Run the accept-all
   sweep iff `autoAcceptAllPending`.
5. `enqueuePrimaryTask` any leftover accepts to the existing idle runner; persist
   the store. Return the summary.

Bounded, best-effort: any single-sender error is logged and skipped, never
throws out of the batch (same contract as the local handshake).

### New server route: `POST /api/campaign/cloud-preflight-handshake`

Body: `{ senderProfileIds, primaryUrl, primarySource, autoAcceptAllPending }`
(token from env). Streams progress to the client via SSE (reuse the existing
campaign-view SSE pattern) OR a `GET …/cloud-preflight-handshake/status` poll —
whichever matches the existing streaming helper; the plan picks one. Returns the
final summary. Runs the module; on completion the client proceeds to dispatch.

### Client: wizard in `_submitCloudCampaign(body)`

Before the `fetch('/api/campaign/start-cloud')`:

```
const t = body.templates || {};
const needsHandshake = body.mode === 'connect_and_introduce'
  && t.autoAcceptPrimary === true
  && (t.primarySource || 'local-browser') === 'local-browser';
if (needsHandshake) {
  const r = await runHandshakeWizard({           // shows the 🤝 modal + live rows
    senderProfileIds: body.profileIds,           // (exact key confirmed in plan)
    primaryUrl: t.primaryUrl,
    primarySource: t.primarySource || 'local-browser',
    autoAcceptAllPending: !!t.autoAcceptAllPending,
  });
  if (!r.ok && !r.proceedAnyway) return;         // abort dispatch on hard failure
}
// …existing start-cloud dispatch unchanged…
```

**Wizard UX** (reuses the handshake panel styling from `handshakeBlock` /
`.hs-*` already in the CSS): a modal titled "🤝 Connecting your senders to the
primary", one row per sender (`connecting → request sent → accepted`), a live
count, and a note "This runs on your Mac — keep the app open. The campaign moves
to the cloud as soon as it's done." On success it auto-closes and the dispatch
proceeds (→ `openCloudLive(id)` as today). On failure it offers **Retry** /
**Dispatch anyway** (senders will connect lazily on the VM once leads accept) /
**Cancel**.

## Interaction with the "follow-up disabled for local-only primary on cloud"

Path B spec decision #2 (follow-up disabled when
`cloud && autoAcceptPrimary && primarySource==='local-browser'`) still holds and
is independent of Path A — the automated follow-up also acts as the primary and
can't run on the VM. Path A does not change it.

## Testing

- **Pure unit (`node --test`):**
  - `planAccountsNeedingConnect` is already tested; add a test that
    `runCloudPreflightHandshake` self-eliminates (returns `ok:true`, launches
    nothing) when all senders are seeded `connected` and accept-all is off —
    inject fake launchers/primitives.
  - `needsHandshake` gate helper (pure) — asserts the trigger matrix:
    CC+IC + autoAcceptPrimary + local-browser → true; GoLogin primary → false;
    autoAcceptPrimary off → false; non-CC+IC → false.
  - Injected-primitive test of the connect→accept happy path: N senders →
    N `buildAcceptTask` → all accepted → summary `connected:N`.
- **Manual / CDP:** launch a cloud CC+IC campaign with a local-only primary +
  auto-accept; confirm the wizard fires, the connect requests **land in the
  primary's inbox**, the local browser accepts them, then the campaign dispatches
  to the VM and intros flow as leads accept. Confirm a GoLogin-primary cloud
  campaign skips the wizard entirely (no regression).

## Risks

- **Blocking launch.** The handshake runs before dispatch, so cloud launch is no
  longer instant for this campaign type. Mitigated by the wizard (clear live
  progress) and the cap/poll bound. Acceptable — it's a one-time upfront step.
- **Orchestration duplication.** `runCloudPreflightHandshake` re-derives the
  connect→accept orchestration from `runPreflightHandshake`. The **risky browser
  primitives are reused untouched**; only the glue is new. Drift risk is on the
  glue, which is straightforward and unit-tested.
- **GoLogin profile contention.** Driving senders locally briefly uses the Mac's
  GoLogin slots. Bounded by the same `browserSemaphore`-style single-open pattern
  (one sender at a time) as the local handshake.
