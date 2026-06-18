# Account-Selection Guardrails (#5) — Design

> Reliability batch, sub-project B. Backlog #5: warn before selecting accounts that are
> assigned to / in use by another operator, or whose credits are in their passover window.
> Backlog: `docs/superpowers/backlog/2026-06-18-suggestions.md`.

**Date:** 2026-06-18
**Status:** Approved for planning
**Off-limits (do NOT touch):** `src/linkedin/outreach.js`, `src/linkedin/actions.js`.

## Problem

The wizard account picker (`renderProfiles`, `public/js/app.js:919`) blocks only **Restricted**
accounts (checkbox disabled) and hides duplicate emails. It does NOT flag:
- an account **assigned to another operator** (SoO `Assignee` ≠ me), or whose credits are
  **In Use** by someone else;
- an account whose relevant **credit window is in passover** (closed), so a campaign
  started now can't actually send.

Operators select these by accident, then waste a run or step on a colleague's account.

## Decisions (locked, from brainstorming)

| Decision | Choice |
|---|---|
| Conditions guarded | **Both:** (a) assigned to / in use by another operator (per-account); (b) passover — the campaign's channel is closed (per-run, mode-aware). |
| Enforcement | **Warn + allow override.** Nothing new is hard-blocked. Restricted stays hard-blocked (unchanged). |
| Visibility treatment | **B + C combined:** a top warning **ribbon** on each flagged card (amber=assigned/in-use, red=restricted) AND an **aggregate alert bar** above the grid summarizing assigned/in-use + passover. Plus a **"Before you start…"** confirm on Start. |
| Reference sketch | `public/sketches/guardrails-final.html` (real app CSS — the look the implementation must match). |

## Hard requirements

1. **Real style.** Use the existing picker markup/CSS (`.profile-item`, `.status-bar-4`,
   `.passover-banner`, `.dup-flag`/`.restricted-flag` patterns). New CSS goes in
   `public/css/style.css` using the app's own tokens (`--ink`, `--gray`, `--green`,
   `--gold`, `--red`, `--hairline`, `--mono`; amber `#d97706` matching `.dup-flag`).
2. **Wired to real SoO data — zero invented data.** Every flag is computed from real fields
   (below). Where data is missing, the flag degrades honestly (e.g. CC has no reserver field
   → "in use" with no name). No fabricated owner names or counts.
3. **Warn, never block (except Restricted).** Flagged accounts stay selectable; the only gate
   is the Start confirm, which always has an override.

### Don't do
- No hard-blocking assigned/in-use/passover accounts (warn only).
- No changes to the Restricted block, the duplicate-hide, the presets, or the filters.
- No `outreach.js` / `actions.js` changes. No `git add -A` (`data/monitoring-campaign.json`).

## Data sources (grounded — verified in code)

Per-account, at selection time, from SoO (`sooData[email]`, loaded by `loadSoOStatus`):
- `Assignee` (string or `-`), `section` (pool/unassigned detection), `Status` (restricted).
- Credit fields: `linkedinCredits`, `inmailCredits`, `salesNavCredits`, `ccCredits` —
  enum `Available | In Use | Used | N/A | ""`.
- Reserver fields: `linkedinUser`, `inmailUser`, `salesNavUser` (email of who holds it).
  **`ccCredits` has NO paired user field** — so a CC "In Use" can be flagged but **not
  attributed** to a person.
- Operator identity: `getMyIdentifier()` (`app.js:1150`) — localStorage override → user chip
  email, lowercased. Assignee match is **substring** (`.includes`), kept as-is.
- Passover: `getPassoverStatus()` (`app.js:795`) — **global + per-channel**: CC active
  Thu–Sun (closed Mon–Wed); OP/InMail/SalesNav active 16th→month-end (closed 1st–15th), PH time.

**Known data limits (state honestly in UI):** CC "In Use" can't name the reserver; passover
is global + mode-dependent (a per-run heads-up, not a per-account state); a stale SoO "In Use"
flag or a loose Assignee match could be wrong — which is exactly why this is warn-not-block.

## Architecture

### Pure classifier — `public/js/account-guardrails.mjs` (new, unit-tested)
Frontend pure module (matches the established `.mjs` pattern: imported by `app.js` via
`/js/account-guardrails.mjs` and by tests via `../public/js/account-guardrails.mjs`). No DOM.

- `classifyAccountFlag(soo, me)` → `{ flagged: boolean, reason: 'assigned'|'in-use'|null,
  label: string }`.
  - **assigned:** not a pool/unassigned section, `Assignee` non-empty and ≠ `-` and does NOT
    include `me` → `reason:'assigned'`, `label: 'assigned to ' + Assignee`.
  - **in-use by another:** any of `linkedinCredits/inmailCredits/salesNavCredits/ccCredits`
    === `In Use` where the paired `*User` (if present) ≠ `me`. With a known reserver →
    `label: 'in use by ' + reserver`; CC or missing reserver → `label: 'in use'`.
  - If both apply, `assigned` wins the label (it's the stronger assignment signal).
  - `me` empty → return `{flagged:false}` (can't compare; don't false-flag).
- `mapModeToChannel(mode)` → `'cc' | 'monthly' | null`. `connect_only` /
  `connect_and_introduce` / `connect_and_message` → `'cc'`; `open_profile_only` → `'monthly'`
  (OP); `inmail_only` → `'monthly'` (InMail); everything else (`message_only`, `check_status`,
  `introduce_back`) → `null` (no credit consumed → no passover warning).
- `passoverWarning(mode, passover)` → `{ channel, label } | null`. Maps mode→channel; if that
  channel is closed (`!passover.cc.active` / `!passover.monthly.active`) → a warning object;
  else null.
- `summarizeSelection(selectedSooList, me, mode, passover)` →
  `{ flagged: [{email,label}], passover: {channel,label}|null, hasWarnings }` — drives the
  aggregate alert bar and the Start confirm.

### Frontend wiring — `public/js/app.js`
- **Per-card ribbon (B).** In `renderProfiles`, after computing `restricted`, also compute
  `classifyAccountFlag(soo, getMyIdentifier())`. If flagged, add class `is-flagged` and a
  `data-warn` attribute (`"⚠ " + label`) on the `.profile-item` (CSS `::before` renders the
  ribbon). Restricted already adds `is-restricted`; it gets a **fixed** red ribbon via CSS
  `::before { content: "⛔ Restricted — blocked" }` (no `data-warn` — it's a single state).
  A flagged card stays selectable; a restricted card stays disabled (unchanged).
- **Aggregate alert (C).** A `#guardrail-alert` element above `#profiles-grid`, re-rendered by
  a new `renderGuardrailAlert()` called wherever selection/SoO/mode changes
  (`renderSelectedPanel` / `updateCampaignSummary` / preset+filter handlers). It reads the
  currently-**selected** accounts' SoO + mode + passover via `summarizeSelection` and shows the
  amber bar only when `hasWarnings`. Hidden otherwise.
- **Passover banner.** Add the amber `passover-closed` class to a channel's `<strong>` in
  `renderPassoverBanner` when that channel is inactive (today inactive shows in plain ink).
- **Start confirm.** At the top of the existing Start handler (`app.js:~3571`, after the
  "select at least one" check), call `summarizeSelection`; if `hasWarnings`, show a confirm
  panel ("Before you start…") listing the flagged selected accounts + the passover heads-up,
  with **Back to selection** / **Start anyway**. "Start anyway" proceeds with the existing
  launch; "Back" aborts. No warnings → start immediately (unchanged).

### CSS — `public/css/style.css`
Add (using app tokens; amber `#d97706`): `.profile-item.is-flagged` + `::before` ribbon;
`.profile-item.is-restricted::before` red ribbon; `.passover-banner strong.passover-closed`;
`.guardrail-alert` + children; the Start-confirm panel classes. Exactly as in
`public/sketches/guardrails-final.html` (that sketch is the visual contract).

## Error handling / edge cases

| Case | Behavior |
|---|---|
| `me` unknown (no identifier) | No flags (can't compare). Passover warning still works (independent of identity). |
| CC "In Use" (no reserver field) | Flag "in use" without a name. |
| Account assigned to me but In Use by someone else | Flagged in-use (reserver ≠ me). |
| Pool/unassigned account | Never "assigned"; can still be "in use by X". |
| Mode doesn't consume credits (`message_only` etc.) | No passover warning. |
| SoO not loaded yet | No flags until SoO arrives (same as today's badges). |

## Testing
- **Pure helper** (`tests/account-guardrails.test.js`, `node:test`): `classifyAccountFlag`
  (assigned-to-other, in-use-by-other, in-use-by-me→not flagged, CC-no-reserver, pool, me-empty);
  `mapModeToChannel`; `passoverWarning` (closed/open per channel); `summarizeSelection`
  (counts, hasWarnings).
- **Manual UI:** ribbons render on flagged/restricted cards; alert bar appears only with
  warnings on selected accounts; Start confirm gates with override; no-warning path unchanged.
- Full suite green; off-limits untouched.

## Done looks like
Open the picker: an account assigned to a colleague shows an amber **"⚠ Assigned to …"** ribbon;
one whose credits are In Use shows **"⚠ In use by …"**; Restricted shows the red blocked
ribbon (unchanged). Select a couple → the amber **alert bar** above the grid summarizes
"2 assigned · CC in passover". Press Start during a CC campaign on Mon–Wed → the
**"Before you start…"** confirm lists them + the passover heads-up; **Start anyway** proceeds.
Every name/count is real SoO data; nothing new is hard-blocked.
