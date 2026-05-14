# Remove Primary-Person Preflight ("Connect Test")

**Status:** Approved for implementation
**Date:** 2026-05-14
**Branch:** `connect-introduce-back-v2.14`
**Supersedes:** `2026-05-14-cc-ic-primary-person-preflight-design.md` (the feature this spec removes)

## Goal

Eliminate the primary-person preflight that runs before every `connect_and_introduce` campaign. The preflight opens LinkedIn compose, types the configured primary person's name, and waits for a recipient pill to appear — gating the campaign on success. It is unreliable in practice (modal hangs, the campaign still doesn't run well even when it passes), and provides no signal the existing `INTRO_RECIPIENT_NOT_FOUND` per-lead error path doesn't already provide at end-of-run.

After this change, `connect_and_introduce` launches go straight from "Fetching sheet…" into the batch loop.

## Non-goals

- **Do not touch `preflightCheckStatus`.** That is a separate feature — a bulk connection-status sweep (no compose, no typeahead) used by `message_only` and `introduce_back` modes. It stays.
- **Do not touch the Primary Person config block in the launch wizard.** The name + URL inputs feed `auto-intro.js`'s 3-way DM body construction. Those inputs and their persistence remain.
- **Do not modify auto-intro.** It consumes primary-person *data*, never the verifier.

## Behavior change

| Before | After |
|---|---|
| `connect_and_introduce` campaign launch shows a "Verifying primary person" modal, opens each sender's profile, runs a compose+typeahead test, and aborts the campaign if any account fails. ~15s+ delay; can hang on typeahead. | Campaign launches immediately. No modal. No pre-launch profile opens. Auto-intro at end-of-run still surfaces `INTRO_RECIPIENT_NOT_FOUND` per lead if 1st-degree isn't actually present (existing handled path). |
| Left-nav has a "Verify primary person" dev button that runs the same check on demand. | Button removed. |
| `POST /api/preflight-only` runs the check via a standalone endpoint. | Endpoint removed. |

## Deletion manifest

### Backend
- **Delete** `src/preflight-primary.js` (orchestrator)
- **Delete** `src/preflight-runner.js` (standalone variant)
- **Delete** `src/linkedin/verify-primary-person.js` (compose+pill verifier)
- **Edit** `src/campaign.js`:
  - Remove import at line 34: `import { runPreflight } from './preflight-primary.js';`
  - Remove the preflight block at lines 1739–1821 (the `if (mode === 'connect_and_introduce')` branch that calls `runPreflight`, handles failure, emits the success log, and invokes `onPreflightComplete`). Also drop the now-orphaned comment block above it.
  - In `startCampaign(...)` signature (line ~964): remove the `onPreflightComplete = null` parameter. Keep `preflightCheckStatus` — it's the bulk-check feature, unrelated.
  - Remove any other references to `onPreflightComplete` (3 invocation sites at ~1754, ~1810, ~1818 all live inside the deleted block, so they go with it).
- **Edit** `server.js`:
  - Remove the `POST /api/preflight-only` route (lines ~2310–2353), including its dev-tool comment header.
  - Remove any `onPreflightComplete` callback wired into `startCampaign` calls in this file (verify during execution).
- **Delete** `tests/preflight-primary.test.js`

### Frontend
- **Edit** `public/index.html`:
  - Remove the left-nav button at line 36: `<button type="button" class="nav-item" onclick="devVerifyPrimaryNow()">Verify primary person</button>`
  - Remove the entire `#preflight-modal` block starting at line 1108 (modal backdrop, all `data-state` panels, action buttons).
  - Remove any `<style>` rules scoped to `.preflight-modal-card`, `.preflight-state*`, `.preflight-eyebrow`, `.preflight-sub`, `.preflight-progress*`, `.preflight-actions`, `.preflight-results*`. (Search the inline `<style>` blocks in this file — there is no separate CSS file in `public/css/`.)
- **Edit** `public/js/app.js`:
  - Remove function definitions and window exports for `openPreflightModal`, `closePreflightModal`, `closePreflightModalAndScrollToPrimary`, `devVerifyPrimaryNow` (lines ~2681, ~2760, ~2774, ~7327 + their `window.*` lines).
  - Remove call sites at lines ~2523, ~2542, ~2558, ~2586, ~2799 — these live in the campaign-launch flow and currently open/close the modal around the preflight network call. Replace with direct launch (the campaign POST happens unconditionally; on success transition straight to the running state without modal).
  - Audit for any orphaned helpers only referenced by the deleted functions.

### Preserved
- `public/index.html` Primary Person block (lines ~253–266): name + URL inputs, `savePrimaryPersonFields()` wiring.
- `src/campaign.js` `preflightCheckStatus` plumbing (line ~1502).
- Historical spec `docs/superpowers/specs/2026-05-14-cc-ic-primary-person-preflight-design.md` left in place as the record of the removed feature.

## Risk

Grepped: `verify-primary-person`, `preflight-primary`, `preflight-runner`, `runPreflight`, `runPreflightStandalone`, `verifyPrimaryPerson`, `devVerifyPrimaryNow`, `openPreflightModal`, `closePreflightModal`, `onPreflightComplete`. No references outside the files listed above.

Auto-intro (`src/linkedin/auto-intro.js`) mentions "primary person" only in its own param docs and DM-body construction — never calls the verifier.

## Verification

1. `npm test` passes (after removing the preflight test file).
2. Launching a `connect_and_introduce` campaign from the UI shows no preflight modal, no "Pre-flight: verifying primary person" log line, and proceeds directly to the batch loop.
3. Left-nav has no "Verify primary person" entry.
4. `curl -X POST http://localhost:<port>/api/preflight-only -d '{}'` returns 404.
5. `message_only` / `introduce_back` modes with the "Check Status" toggle on still emit `Pre-flight Check Status sweep…` (preserved bulk-check feature).
6. `grep -rn "preflight-primary\|verify-primary-person\|runPreflight\|devVerifyPrimaryNow\|openPreflightModal" src/ electron/ public/ server.js tests/` returns no hits.
