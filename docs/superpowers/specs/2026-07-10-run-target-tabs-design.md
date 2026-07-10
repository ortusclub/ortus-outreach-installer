# Run-target tabs ("Where it runs" — local vs VM at the top) — design

**Date:** 2026-07-10
**Branch:** preflight-linter-2135
**Status:** approved (variant F "Command Tabs", picked from sketches)
**Sketch:** `public/sketches/2026-07-10-run-target-FGH.html` (winner: F; G/H rejected)
**Related:** `2026-07-10-primary-config-overhaul-design.md` (Manifest reacts),
`2026-07-10-cloud-primary-handshake-design.md` (handshake line + sender rules)

---

## Problem

"Running in cloud (beta)" is a checkbox at the bottom of **6 · Launch**
(`#cloud-run-toggle` / `#cloud-run-checkbox`, `public/index.html` ~2412; read by
`app.js` `refreshCloudToggle()` ~5643-5677). The operator decides *where the campaign
runs* — a choice that shapes modes, primary behavior, follow-up, and controls — as an
afterthought below the Start button. It must move to the **top of the wizard** as the
first decision, and everything downstream must align to it.

## Design — F · Command Tabs

An **unnumbered "Where it runs" block above Section 1 · Campaign Type**:

1. **Two large segmented tabs** (same visual family as the Campaigns | Sales Nav
   `.route-seg`, but two-line):
   - `💻 THIS MACHINE` — sub: "Runs while the app is open — pause & resume anytime"
   - `☁︎ CLOUD VM` — sub: "Keeps going after you close the laptop"
   Active tab = solid ink. Default: **This machine** (parity with today's default-off
   checkbox for non-FG modes; keep whatever per-mode default `refreshCloudToggle`
   applies today).
2. **Facts row** under the tabs — swaps with the active side:
   - Local: `✓ Full control — pause, resume, edit mid-run · ✓ Every mode available ·
     — Stops if the app closes or the Mac sleeps`
   - VM: `✓ Survives closing the laptop · ✓ Watch it live with 👁 Show on the board ·
     — Stop only — no pause/resume · — ~2-3 min warm-up · — Senders must be GoLogin
     accounts · — No automated follow-up (local primary)`
3. The Launch-section checkbox is **removed** (label row deleted; the hidden
   `#cloud-run-checkbox` input may remain as the single source of truth the tabs
   write to, so `refreshCloudToggle`/launch payload code keeps working unchanged).

## Downstream reactions (single source of truth: the tab state)

- **Section 1 · mode grid**: when VM, modes not in `CLOUD_MODES`
  (`src/campaigns-client.js`) render disabled with a `💻 LOCAL ONLY` tag (e.g.
  `check_dms`, `post_amplification`). If the currently-selected mode becomes
  local-only, switching to VM keeps the selection but shows the wizard's existing
  blocked treatment + a hint to switch back (never silently change the mode).
- **Section 3 · Manifest** (per the overhaul + handshake specs): VM + local primary →
  follow-up line replaced by the gold handshake line ("Your Mac accepts once — locked
  first step — then everything runs on the VM; follow-up off for this run");
  follow-up row disabled in the Customize drawer with the same reason.
- **LinkedIn accounts picker**: when VM, local-browser-only sender entries are
  hidden/flagged (handshake spec decision #3).
- **Section 6 · Launch**: when VM — hide `Queue it` / `Schedule it` **iff** they don't
  support cloud dispatch today (verify `launchQueueIt`/`launchScheduleIt` paths during
  planning; if they already work with the cloud flag, keep them and only change the
  note). Note text: local "Runs here — keep the app open." / VM "Starts on the VM —
  close the laptop whenever. Watch it with 👁 Show."
  The FG cloud extras (`#cloud-fg-extras`) keep their current visibility logic, now
  keyed off the tab state.
- **Engine not configured** (`isCampaignEngineConfigured()` false): VM tab disabled
  with tooltip "Cloud engine not configured".

## Constraints

- **No payload changes**: launch/queue/draft payloads must be byte-identical to
  today's for the same effective choice — the tabs are a new face on the existing
  flag.
- Persistence: the choice saves/restores exactly like the checkbox does today
  (drafts, duplicated campaigns, `onModeChange` re-evaluation).
- Design system: segmented pill tabs, ink/bg inversion for active, mono uppercase;
  facts row is plain text with ✓/— mono markers; no new colors.

## Acceptance

1. The wizard opens with the tabs above Section 1; the Launch checkbox is gone.
2. Flipping tabs updates: mode-grid availability, Manifest lines, accounts picker,
   Launch buttons/note, FG extras — with no reload.
3. A draft saved on VM reopens on VM; payloads unchanged vs. today.
4. VM tab disabled (with tooltip) when the engine isn't configured.
5. Switching to VM with a local-only mode selected blocks launch with a clear hint,
   never silently changes the selection.
