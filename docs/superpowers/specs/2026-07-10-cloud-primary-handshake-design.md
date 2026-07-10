# Cloud primary-handshake hard-lock — design

**Date:** 2026-07-10
**Branch:** preflight-linter-2135
**Status:** approved (brainstorm) → ready for plan
**Related:** `docs/cloud-engine-primary-handshake-spec.md` (engine handoff),
`project_ortus_cloud_parity`, `project_primary_side_identity_model`

---

## Problem

CC+IC (`connect_and_introduce`) and CC+DM (`connect_and_message`) campaigns have a
**primary person** the lead gets introduced to. Before the intro can happen, each
sender account must be **connected to the primary**. Locally the app does this with
`runPreflightHandshake` (`src/campaign.js`): each sender sends a connect-request to
the primary, then the **primary's own browser accepts** those invitations
(`src/linkedin/accept-invitation.js` → `acceptInvitationFrom`).

The accept runs in whatever browser the primary is logged into — encoded in the
single config key `primarySource`:

- `'local-browser'` → a headed Chrome the app launches **on the operator's Mac**
  (`src/local-launcher.js` `launchLocalBrowser`, persistent `data/local-profile`).
- a **GoLogin profileId** → a cloud-drivable profile.

**On the VM this breaks.** The cloud engine has no operator Chrome, so a
`primarySource === 'local-browser'` primary — which is the *default* and, per the
operator, the *common* case — **cannot be accepted-as by the VM**. The flags are
forwarded to the engine (`server.js` spreads templates into `config`) but the accept
physically cannot run there.

Established during brainstorm: the primary is **often local-only**, so we cannot just
require a GoLogin primary. The Mac must do the accept — but *only* the accept.

## Key insight — sender-side vs primary-side

Every CC+IC / CC+DM campaign is two kinds of work:

| Work | Acts as | Runnable on VM? |
|---|---|---|
| Connect to leads · connect-request to the primary · send the intro | **sender** (GoLogin) | ✅ yes |
| **Accept** the senders' invites · send the **follow-up** | **primary** | ✅ only if primary is GoLogin — ❌ if local-only |

So for a **local-only primary**, the split is forced: the **VM does all sender-side
work**; the **Mac does the primary-side accept**. A LinkedIn invitation sits pending
for weeks, so the accept is *deferrable* — the VM can fire the connect-requests and
the accept can complete later, on the Mac.

## The hard-lock handshake (operator's own spec)

The campaign opens with a **hard-locked Phase 0**. Nothing touches a lead until it
clears:

1. **VM — connect.** The N GoLogin senders each send a connect-request to the primary.
2. **VM — pause.** The campaign enters `awaiting_primary_accept` and blocks, exposing
   which senders are waiting on the primary.
3. **Mac — accept.** This app (it launched the campaign and owns the local primary
   browser) detects that state, opens the local primary browser, accepts exactly
   those N invitations, and signals the engine "done."
4. **VM — release.** The lock releases; the campaign runs **100% on the VM** to the end.

The Mac's *only* job in the whole campaign is step 3.

## Decisions (locked in brainstorm)

1. **Targeted accept, plus the existing accept-all toggle.** The Mac accepts exactly
   the campaign's N senders (matched by identity). The existing "Also accept all other
   pending invitations" toggle (`autoAcceptAllPending`) **stays honored** — when on,
   the Mac also runs the indiscriminate sweep during the handshake window.
2. **Follow-up disabled for a local-only primary on cloud.** The automated first
   follow-up *also acts as the primary* ("Sent from your primary — your local
   browser", `#follow-up-primary-label`). A local-only primary can't send it from the
   VM, and we want "100% VM after the handshake" to hold. So when `where === 'cloud'
   && autoAcceptPrimary && primarySource === 'local-browser'`, the follow-up is
   **disabled with a clear inline reason** (not silently dropped).
3. **Cloud senders must be GoLogin.** A local-only sender account can't be driven by
   the VM at all. When "Run in cloud" is on, local-only sender accounts are
   **hidden/flagged** in the account picker (they can't be selected for a cloud run).
4. **UI: A+B hybrid.** Inline lock panel on the strip as the resting state (variant
   A), plus a one-time modal (variant B) that fires the first moment the lock engages
   so the operator can't miss that the campaign is waiting on their Mac. Compact line
   (variant C) is the documented fallback if the board gets busy — not built now.
   Sketch: `public/sketches/2026-07-10-cloud-primary-handshake-lock.html`.

## Ownership & who does the accept

Only the app that **launched** the cloud campaign owns the handshake — it set
`primarySource = 'local-browser'`, meaning *its* local browser is the primary. Other
operators' apps must not try to accept (they aren't logged in as the primary). The
launching app records itself as handshake owner at dispatch (it already builds the
cloud config in `server.js` and knows `primarySource` + the sender roster).

## App-side design (buildable in this repo)

New module `src/cloud-primary-handshake.js` — a poller/bridge, sibling of the existing
reconcilers (`cloud-soo-reconcile.js`, `cloud-sheet-reconcile.js`):

- **Watch:** for each cloud campaign this app owns where `autoAcceptPrimary &&
  primarySource === 'local-browser'`, poll `GET /api/campaign/:id` for
  `state === 'awaiting_primary_accept'`. Runs on the same idle discipline as
  `primary-task-runner` (only when the local browser is free).
- **Accept:** open the local primary browser once (`launchLocalBrowser`) and, for each
  waiting sender identity the engine reports, run the existing `acceptInvitationFrom`
  (matched by name/URL). If `autoAcceptAllPending`, also run
  `acceptAllPendingInvitations`. Reuses `src/primary-task-runner.js` machinery — no
  new accept executor, `accept-invitation.js` untouched.
- **Signal:** `POST /api/campaign/:id/primary-accept-done` with the accepted sender
  ids. The engine verifies + resumes (see engine spec).
- **Proxy routes** in `server.js` mirror the existing cloud proxies
  (`/api/campaign/cloud/:id/leads`).

Client additions in `src/campaigns-client.js`: `getCloudCampaign` already exists;
add `signalPrimaryAcceptDone(id, acceptedIds)`.

### UI (public/js/app.js + index.html)

- **Strip (variant A):** when `it.state === 'awaiting_primary_accept'`, render the
  `.hs-panel` lock inside the strip (per sketch) instead of the log: eyebrow
  "Phase 0 · Primary handshake — locked", progress `accepted/total`, per-sender rows
  (accepted / accepting / waiting), the accept-all line when on, "keep the app open."
  Status pill shows the lock; foot shows **Skip & continue** + **Cancel** + Open.
- **Modal (variant B):** the first time a given campaign enters the lock this session,
  pop the centered modal once (reuse the `snm-` modal pattern already in
  `index.html`), then dismiss to the inline panel. Track "already shown" per campaign
  id so it fires once, not every poll.
- **Release:** when state leaves `awaiting_primary_accept`, the strip flips to the
  normal running view (green dot, 👁 Show / Stop / Open) — no reload needed.
- **Settings section:** when cloud + local-only primary, disable the follow-up toggle
  (`#follow-up` area) with an inline note; flag local-only senders in the picker.

## Engine-side design (handoff — not in this repo)

Detailed in `docs/cloud-engine-primary-handshake-spec.md`. Summary of the contract:

- Run Phase-0 connect-to-primary for each sender before any lead outreach.
- Enter `state: 'awaiting_primary_accept'`, exposed on `GET /api/campaign/:id` with
  `primary {name,url}` and `senders [{profileId,name,url,accepted:bool}]`.
- Accept `POST /api/campaign/:id/primary-accept-done`; **re-verify** at least one
  sender↔primary connection server-side before resuming (don't blindly trust the
  signal), then release the lock and run the rest.
- Idempotent: a repeated Phase-0 or a duplicate done-signal must not double-send or
  double-advance.

## Failure / timeout handling

- **Mac never opens / accept fails:** the campaign sits at the lock. The strip shows
  "Waiting for your Mac to accept — X/N", the modal made the ask explicit, and the
  operator has **Skip & continue** (run anyway — intros just wait until the connection
  exists; the VM's auto-check loop fires them once accepted) and **Cancel** (stop).
- **Partial accept:** the per-sender rows show exactly which senders are still
  pending, so a stuck one is visible rather than a silent stall.
- **Never silently proceed** without either a verified accept or an explicit Skip.

## Non-goals (YAGNI)

- No VM→Mac push channel — LinkedIn is the transport for the invite; the Mac *polls*
  the engine for the awaiting state. No inbound connection to the Mac.
- No GoLogin-primary auto-provisioning — if the primary happens to be a GoLogin
  profile, the engine already can accept and no Mac step is needed (out of scope here;
  this design targets the local-only-primary case).
- Variant C not built now (documented fallback only).
- No follow-up-on-Mac deferral (decision #2 chose to disable instead).

## Testing

- Unit: handshake state parsing, "already shown modal" once-per-campaign gate,
  sender-identity → accept-task mapping, follow-up-disable predicate
  (`cloud && autoAcceptPrimary && primarySource==='local-browser'`), local-only-sender
  filter for the cloud picker. `node --test`.
- Manual: the sketch demonstrates the states; live end-to-end needs the engine side +
  a real acceptance (can't be faked), so app-side lands correct-by-construction and
  auto-confirms on the first real cloud CC+IC run once the engine ships Phase 0.

## Acceptance criteria

1. A cloud CC+IC/CC+DM campaign with a local-only primary shows the **hard-lock**
   waiting state (A inline + one-time B modal) while `awaiting_primary_accept`.
2. The Mac accepts **only** the campaign's senders (plus all-pending iff the toggle is
   on), signals done, and the strip **flips to running** on release.
3. The follow-up is **disabled with a visible reason** in that configuration.
4. Local-only sender accounts **cannot be selected** for a cloud run.
5. Skip/Cancel both work; nothing proceeds past the lock without a verified accept or
   an explicit Skip.
