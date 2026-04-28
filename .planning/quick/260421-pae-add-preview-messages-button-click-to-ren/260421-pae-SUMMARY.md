---
phase: 260421-pae
plan: 01
subsystem: campaign-ui
tags: [preview, templates, ui, modal, personalization, linkedin-limits]
type: execute
status: awaiting-verification
requirements:
  - QUICK-260421-PAE
dependency_graph:
  requires:
    - src/campaign.js (extractLinkedInUrl)
    - src/linkedin/helpers.js (personalizeTemplate)
    - src/sheets.js (fetchSheet)
  provides:
    - "POST /api/templates/preview endpoint"
    - "Preview Messages UI button + modal"
    - "CHAR_LIMITS constants (300/200/1900 for LinkedIn fields)"
    - "gatherCampaignFormState() helper reusable by other UI surfaces"
  affects:
    - server.js (one new route, two new imports)
    - public/index.html (one button, one modal element)
    - public/js/app.js (new preview module added near top of file)
    - public/css/style.css (.preview-modal__* / .preview-card__* rules)
tech_stack:
  added: []
  patterns:
    - "Named ES module export for cross-file reuse (extractLinkedInUrl)"
    - "Modal lifecycle via hidden attr + event-listener cleanup (mirrors promptModal)"
    - "Error-as-200 pattern: { previews: [], error } to keep UI simple"
key_files:
  created:
    - .planning/quick/260421-pae-add-preview-messages-button-click-to-ren/260421-pae-SUMMARY.md
  modified:
    - src/campaign.js
    - server.js
    - public/index.html
    - public/js/app.js
    - public/css/style.css
decisions:
  - "Preview endpoint mirrors /api/campaign/start body shape so the client reuses one form-state gatherer for both flows"
  - "Warnings are computed BEFORE personalizeTemplate runs — that function strips unresolved {placeholders} silently, so scanning the raw templates is the only way to surface misses"
  - "Sheet-fetch failures return HTTP 200 with { previews: [], error } instead of a 4xx/5xx, matching the general UI convention and avoiding status-code parsing on the client"
  - "Character limits hard-coded as constants (connectionNote 300, inmailSubject 200, inmailBody 1900) — LinkedIn-imposed limits, not user-configurable"
  - "No refactor of personalizeTemplate or extractLinkedInUrl beyond adding `export` to the latter (delivery-hardening rule: preserve core automation logic)"
metrics:
  duration_minutes: 6
  tasks_completed: 2
  tasks_total: 3
  tasks_pending_human: 1
  files_modified: 5
  completed_date: "2026-04-21"
---

# Quick 260421-pae: Preview Messages Summary

**One-liner:** Operators can render current message templates against 3 real leads from the selected sheet and see character counts + unresolved-placeholder warnings before launching a campaign.

## What Shipped

Two code tasks committed and verified. Task 3 is a human-verification checkpoint — awaiting operator.

### Task 1 — Server endpoint `POST /api/templates/preview` (commit `8793a73`)

- `src/campaign.js` line 84: `extractLinkedInUrl` is now exported (no behavior change; existing internal call sites at lines 329, 545, 574 still resolve because the function name and scope are unchanged).
- `server.js`: imports `extractLinkedInUrl` from `./src/campaign.js` and `personalizeTemplate` from `./src/linkedin/helpers.js`. Inserted a new route directly after `/api/sheet/preview`.
- Endpoint accepts the same body shape as `/api/campaign/start`: `{ sheetUrl, linkedinColumn, templates, profileIds, senderFirstNames }`.
- Returns `{ previews: [...] }` where each entry is `{ lead: { firstName, lastName, company, url }, rendered: { connectionNote, followUpMessage, inmailSubject, inmailBody, opProfileSubject, opProfileBody }, warnings: string[] }`.
- Empty-template rejection: HTTP 400 `{ error: 'At least one template field must be provided' }` when all 6 fields are blank.
- Sheet-fetch failure: HTTP 200 `{ previews: [], error }` so the UI can render a readable message without parsing status codes.
- Unresolved placeholders surface as `"{placeholderName} not resolved for <Field Label>"` warnings, computed BEFORE `personalizeTemplate` runs (which silently strips them).

### Task 2 — UI button + modal + click handler + renderer (commit `0066ece`)

- `public/index.html`: `<button id="btn-preview-messages">` added inside `.templates-header`; `<div id="preview-modal">` added next to the existing `#prompt-modal` reusing the `.prompt-modal` + `.prompt-modal__backdrop` skeleton.
- `public/js/app.js`: new `CHAR_LIMITS`, `PREVIEW_FIELD_LABELS` constants; `gatherCampaignFormState()`, `getPreviewDisabledReason()`, `refreshPreviewButtonState()`, `handlePreviewClick()`, `escapeHtml()`, `renderPreviewModal()`; DOMContentLoaded listener wires `input` events on sheet-url + 6 template fields to keep button state in sync.
- Button disabled (with explanatory `title`) when sheet URL is empty OR all 6 template fields are empty; enabled otherwise.
- Click shows "Loading…" on the button, POSTs to `/api/templates/preview`, opens the modal with results, restores button label in a `finally` block.
- Modal closes on backdrop click, close button, and ESC key (listeners are cleaned up on close to avoid leaks).
- `public/css/style.css` appended with `.preview-modal__*` and `.preview-card__*` rules. `.preview-card__count--over` uses `var(--red)` (existing token at line 20) for fields over their limit.

### Task 3 — Human verification (pending)

`checkpoint: awaiting operator` — see the 8-step verification script in the PLAN's `<how-to-verify>` block. The operator runs through the flow against a real sheet and confirms "approved" or reports regressions.

## Verification

- `node --input-type=module -e "import('./src/campaign.js').then(m => m.extractLinkedInUrl(...))"` → `OK: extractLinkedInUrl exported and functional`
- `node -c server.js` → parses cleanly
- `node --check public/js/app.js` → parses cleanly
- `grep` probes confirmed: `btn-preview-messages`, `preview-modal`, `handlePreviewClick`, `gatherCampaignFormState`, `CHAR_LIMITS` in app.js; `preview-card__count--over` in style.css.

## Deviations from Plan

None — plan executed exactly as written. No bugs, missing dependencies, or architectural surprises. `personalizeTemplate` was already exported, the CSS tokens referenced (`--red`, `--gray`, `--ink`, `--hairline`, `--mono`, `--body`) all exist, and the `.prompt-modal` class skeleton rendered correctly for reuse.

## Known Stubs

None. All data flows are wired end-to-end. Preview cards render real data from the sheet, `extractLinkedInUrl` is the production function, `personalizeTemplate` is the production renderer, and the warnings block is computed from real placeholder scans — not mock content.

## Commits

| # | Task                              | Commit    | Files                                           |
|---|-----------------------------------|-----------|-------------------------------------------------|
| 1 | Server endpoint + export refactor | `8793a73` | src/campaign.js, server.js                       |
| 2 | UI button + modal + styles        | `0066ece` | public/index.html, public/js/app.js, public/css/style.css |

## Self-Check: PASSED

- [x] `src/campaign.js` line 84 starts with `export function extractLinkedInUrl` — verified via module import at runtime
- [x] `server.js` has `extractLinkedInUrl` in the campaign.js import + `personalizeTemplate` imported from helpers.js
- [x] `app.post('/api/templates/preview', ...)` exists directly after `/api/sheet/preview`
- [x] `node -c server.js` passes
- [x] `public/index.html` contains `#btn-preview-messages` + `#preview-modal`
- [x] `public/js/app.js` defines all required functions + `CHAR_LIMITS` + DOMContentLoaded listener (`node --check` passes)
- [x] `public/css/style.css` has `.preview-modal__*` + `.preview-card__count--over` rules
- [x] Commits `8793a73` and `0066ece` present on current branch (`git log --oneline -3` shows both as the two latest non-docs commits)
- [x] No unintended file deletions (`git diff --diff-filter=D --name-only HEAD~2 HEAD` empty)
