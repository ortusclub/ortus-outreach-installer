# Primary-person config overhaul ("The Manifest") — design

**Date:** 2026-07-10
**Branch:** preflight-linter-2135
**Status:** approved (variant D + loud Customize, picked from sketches)
**Sketches:** `public/sketches/2026-07-10-primary-config-overhaul-DE.html` (winner: D),
`…-primary-config-redesign-ABC.html` (A/B/C rejected — reorganized but still overwhelming)
**Related:** `2026-07-10-cloud-primary-handshake-design.md` (the cloud notice this UI hosts)

---

## Problem

The CC+IC / CC+DM primary area (`#primary-person-block`, `#auto-accept-block`,
`#check-cadence-block`, `#follow-up-block` in `public/index.html` ~799–961) stacks four
bordered panels ≈12 always-visible controls. Operators find it overwhelming; the
relationships (one identity drives every primary-side action) are invisible.

Per-campaign, the operator really only decides **who the primary is**. Everything else
is a stable default: auto-accept on, cadence 1 h, checks auto, follow-up 10 min,
local-browser identity.

## Design — reduction, not reorganization

Replace the four panels with **one panel** in three zones:

1. **Identity** — Full name + LinkedIn URL side by side. (The two real inputs.)
2. **Readback** — eyebrow `WHAT HAPPENS AUTOMATICALLY — STANDARD|CUSTOMIZED`, then
   three ✓ sentences **rendered from the live settings**:
   - `✓ After connections complete, each sender requests <name> — <name>'s local
     browser accepts automatically [+ all other pending invites ⚠️]`
   - `✓ Acceptances checked every 1 hour; intros fire as they land` (off →
     `— Automatic checks off — run them with ⚡ Check now`)
   - `✓ First follow-up 10 minutes after the last intro` (off → `— No automated
     follow-up`)
   Off-lines render dimmed with `—` instead of `✓`. Nudge line beneath: *"Every line
   above is a setting — hit Customize to change any of them."*
3. **Customize** — a **solid ink pill with sliders icon** (the only solid button in the
   panel — deliberately loud so it gets pressed; user-requested). Opens an inline
   drawer of compact rows holding EVERY removed control: auto-accept toggle,
   accept-all toggle (+⚠️ hint), logged-in-via select (local / GoLogin picker),
   primary-check-timing select, checks toggle + cadence select, follow-up toggle +
   delay select. Button flips to outline `✕ Done`. Any change re-renders the readback
   immediately and flips the eyebrow STANDARD→CUSTOMIZED when values differ from
   defaults.

The cloud-handshake notice (`hard-lock` design) renders as one gold-edged line under
the readback when `where === 'cloud' && primarySource === 'local-browser'`, and the
follow-up line dims (disabled per the handshake design decision #2).

## Constraints

- **No behavior/config changes** — same keys (`primarySource`, `autoAcceptPrimary`,
  `autoAcceptAllPending`, `primaryCheckTiming`, cadence, `followUp*`), same
  save/load (`savePrimaryPersonFields` etc.), same `onModeChange` visibility gating,
  same defaults. UI-only.
- **Keep existing element IDs** where JS reads them (`primary-person-name`,
  `primary-person-url`, `primary-source-*`, `auto-accept-*`, `check-cadence-select`,
  `auto-checks-toggle`, `follow-up-*`) — relocate, don't rename, so app.js keeps
  working with minimal churn.
- **URL gate stays**: without a primary URL, auto-accept can't be on (existing
  `refreshAutoAcceptGate`); in the drawer the row disables with the existing 🔒 hint;
  the readback line-1 renders as `—` off-line.
- The GoLogin picker (`#primary-source-picker` search + SoO grid) moves inside the
  drawer's logged-in-via row, unchanged.
- Design system: monochrome, hairlines, radius 0/9999, solid ink only for the
  Customize pill; gold only on the cloud notice edge (status, not CTA).

## Acceptance

1. Resting state shows exactly: 2 inputs + eyebrow + 3 readback lines + nudge +
   Customize. Nothing else.
2. Readback always tells the truth: every drawer change re-renders it; customized
   values read back as plain English; STANDARD/CUSTOMIZED flag correct.
3. All 12 original controls reachable in the drawer; save/load/launch payloads
   byte-identical to today for the same choices.
4. Cloud + local primary → gold notice line + dimmed follow-up line.
