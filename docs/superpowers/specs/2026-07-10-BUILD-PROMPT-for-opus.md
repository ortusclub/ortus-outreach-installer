# BUILD PROMPT — paste this to Opus 4.8 (or tell it to read this file)

> You are building three approved, spec'd features in the Ortus Outreach repo
> (`/Users/antoniovarlese/ortus-gologin-clone`, branch `preflight-linter-2135`).
> All design decisions are already made and locked — do NOT re-open design
> questions. The designs were picked from live sketches by the operator.

## Read first (in this order)

1. `docs/superpowers/specs/2026-07-10-primary-config-overhaul-design.md` —
   **Feature 1 "The Manifest"**: replace the four primary-person panels in the
   wizard with one panel (2 fields + 3 readback sentences + loud solid-ink
   Customize drawer). UI-only, same config keys and element IDs.
2. `docs/superpowers/specs/2026-07-10-run-target-tabs-design.md` —
   **Feature 2 "Command Tabs"**: move "Running in cloud" from the 6·Launch
   checkbox to two big tabs (💻 This machine / ☁︎ Cloud VM) above Section 1,
   with a swapping facts row; wizard reacts downstream (mode grid, Manifest,
   accounts picker, Launch buttons/notes).
3. `docs/superpowers/specs/2026-07-10-cloud-primary-handshake-design.md` —
   **Feature 3 "Primary handshake hard-lock" (app half only)**: for cloud CC+IC /
   CC+DM with a local-only primary — poll for `awaiting_primary_accept`, drive the
   local primary browser to accept the campaign's senders (reuse
   `primary-task-runner` + `acceptInvitationFrom`; `accept-invitation.js` and the
   off-limits files stay untouched), signal done, and render the lock UI
   (inline panel + one-time modal, per sketch). The ENGINE half is
   `docs/cloud-engine-primary-handshake-spec.md` — a handoff document, NOT yours
   to build; the app half must degrade gracefully while the engine state doesn't
   exist yet (same pattern as `openCampaignViewStream`'s 501 handling).

## Pixel truth (approved sketches — match them)

- Feature 1: `public/sketches/2026-07-10-primary-config-overhaul-DE.html` → variant **D**
  (with the loud solid Customize pill + nudge line).
- Feature 2: `public/sketches/2026-07-10-run-target-FGH.html` → variant **F**.
- Feature 3: `public/sketches/2026-07-10-cloud-primary-handshake-lock.html` →
  **A+B hybrid** (inline panel resting state + modal fired once when the lock engages).

## Build order & process

Order: **Feature 1 → Feature 2 → Feature 3** (2 keys the Manifest's cloud state;
3 renders into the board strips independently).

Process (repo convention): invoke the **writing-plans** skill to produce ONE plan
covering all three features as commit-sized tasks, then execute it (the repo uses
subagent-driven development; follow the plan skill's output). Run the full suite
(`node --test tests/*.test.js`) green before calling any feature done.

## Hard rules (from CLAUDE.md + operator memory — do not violate)

- `src/linkedin/outreach.js` and `src/linkedin/actions.js` are OFF-LIMITS.
- Patch-bump `package.json` version + the two `?v=` cache-bust strings in
  `public/index.html` BEFORE every relaunch; relaunch `npm run dev:app` in the
  background after each commit that touches runtime code.
- Never `git add data/monitoring-campaign.json`.
- Launch/queue/draft payloads must stay byte-identical for unchanged choices —
  these are UI-refactor features, not behavior changes (except the new handshake
  poller/bridge, which is additive).
- Verify UI 1:1 against the sketches (real CSS, real components). CDP/screenshot
  verification is the norm here.
- Do not commit without the operator's explicit go-ahead. Note: v2.146.1→v2.154.0
  work is ALSO uncommitted on this branch — keep your commits separable from it.

## Current state you inherit

- App running via `npm run dev:app`, v2.154.x, port 7847.
- The cloud parity stack (per-lead logs, sheet reconcile 1:1, SoO weekly bump,
  👁 Show button + graceful 501) is already built and live — reuse its patterns
  (`src/cloud-*-reconcile.js`, `campaigns-client.js`).
- Engine specs pending external deploy: needs-login, campaign-view, primary-handshake.
