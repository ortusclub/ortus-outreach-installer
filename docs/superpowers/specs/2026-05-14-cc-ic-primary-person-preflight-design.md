# CC+IC Primary Person Pre-flight — Design Spec

**Status:** Draft, pending operator review
**Date:** 2026-05-14
**Author:** Antonio (with Claude)
**Scope:** Connect + Introduce Back mode — launch-time verification of the configured primary person, plus matcher hardening in the in-campaign intro-DM send
**Sketch:** `public/sketches/preflight-primary-v1.html`
**Source bugs:** Boss's CC+IC run where `Check Status` was blank and zero auto-intros fired — root-caused to fragile primary-person typeahead matching plus a missing connection on some sender accounts. Click-time hard-block for empty primary fields already shipped in commit `6d9c130`; this spec hardens the remaining fragility.

---

## 1. Goal

Make CC+IC campaigns refuse to start unless the configured primary person is **provably reachable** from every active sender account. Eliminate the failure mode where connection requests go out, leads accept, and zero intros fire because the typeahead can't find the primary person.

In parallel, strengthen the in-campaign typeahead matcher in `sendIntroMessage` so that — even if the pre-flight passes — a near-miss (e.g. `Sam` vs `Samuel`) no longer breaks the intro send.

---

## 2. User stories

- **S1.** Operator clicks Start on a CC+IC campaign. Before any connection request is sent, a modal shows "Verifying primary person on 3 accounts…" with a per-profile checklist. Within ~15 seconds either the campaign starts normally (all pass) or a hard-block modal appears explaining exactly which account(s) failed and why.
- **S2.** When pre-flight fails because the configured name doesn't match LinkedIn's display, the failure modal shows the **canonical name** read from the primary person's actual LinkedIn profile page (e.g. "LinkedIn shows this person as Samuel Ferrer"). A one-click pill `Use "Samuel Ferrer"` updates the wizard's Primary Person Name field and re-runs the pre-flight.
- **S3.** When pre-flight fails because the primary person isn't a 1st-degree connection on some account, the modal lists that account by email and says "Sam Ferrer is not a 1st-degree connection on this account. Intros from this account would fail every time."
- **S4.** When pre-flight fails because the configured Primary Person LinkedIn URL is invalid (404), the modal calls out the bad URL and prompts the operator to fix it.
- **S5.** Operator opens the CC+IC wizard. The Primary Person LinkedIn URL field is now **required** (red asterisk + click-time validation, same UX as the existing empty-name hard-block). They cannot proceed with URL blank.
- **S6.** Even if pre-flight is somehow bypassed (e.g. campaign restored from snapshot without re-verifying), the in-campaign `sendIntroMessage` matcher tolerates near-misses: configured `Sam Ferrer` still matches LinkedIn's `Samuel Ferrer` via token-prefix matching, and if the typeahead returns exactly one candidate, it gets clicked as a safety net.
- **S7.** When the in-campaign matcher fails, the error logged to `data/campaign-log.txt` and the sheet's `Audit Action` column now includes the top 3 candidates seen — so future debugging doesn't require running another live campaign.

---

## 3. Architecture

Two new modules + two surgical edits. No off-limits files touched except `src/linkedin/actions.js` (matcher block only — explicit operator permission granted).

```
NEW   src/linkedin/verify-primary-person.js   ── per-profile verifier
NEW   src/preflight-primary.js                ── multi-profile orchestrator
EDIT  src/campaign.js                         ── call pre-flight before campaign loop
EDIT  src/linkedin/actions.js                 ── matcher upgrade in sendIntroMessage (lines ~1424-1445)
EDIT  server.js                               ── return pre-flight failures in start-campaign response
EDIT  public/index.html                       ── wizard URL field becomes required; pre-flight modal markup
EDIT  public/js/app.js                        ── handle pre-flight failure response, render modal
EDIT  public/css/style.css                    ── pre-flight modal styles
```

---

## 4. Pre-flight algorithm (per profile)

Runs once per active sender profile, in parallel via `Promise.all`. Total timeout 60s overall.

Each profile executes the steps below in order. **First failure short-circuits** (no point typing the name if the URL itself is bad).

### Step 1 — Visit primary URL
- Navigate to `primaryUrl` with `waitUntil: 'domcontentloaded'`, timeout 15s.
- If navigation throws OR the page title/h1 indicates "Profile not found" / "Page doesn't exist", return `{ ok: false, failureType: 'url_invalid', detail: <url + status> }`.

### Step 2 — Extract canonical name
- Read `h1` (or LinkedIn's profile-name selector) → strip whitespace → store as `canonicalName`.
- Captured BEFORE the Message-button check so that `not_connected` failures still carry the canonical name (useful in debugging — operator can see "we found the person, just not as a connection on this account").

### Step 3 — Check "Message" button presence
- Look for the profile-page Message button (selector: same one `sendMessage` uses to open the DM compose, defined in `actions.js`).
- If absent → return `{ ok: false, failureType: 'not_connected', canonicalName, detail: 'No Message button on profile — not a 1st-degree connection' }`.

### Step 4 — Typeahead test
- Navigate to `/messaging/compose/?recipient=<self-publicId>` (or `/messaging/`).
- Reuse the same tag-input + `page.type` + dropdown-poll logic as `sendIntroMessage` (lines 1321-1435 of `actions.js`). This is the duplication-cost called out in section 3 — required because actions.js is off-limits for adding a verify-only flag.
- Capture the top 3 visible candidates (`{ name, headline }`) regardless of match outcome.
- Apply the **upgraded matcher** (section 5) against the configured `primaryName`.
- If no match → return `{ ok: false, failureType: 'name_mismatch', canonicalName, candidates: [...] }`.

### Step 5 — Success
- Return `{ ok: true, canonicalName, candidates: [...] }`.

### Module signature

```js
export async function verifyPrimaryPerson({
  page,            // puppeteer Page on a logged-in LinkedIn session
  profileName,     // sender's display label (email)
  primaryName,
  primaryUrl,
  log = console.log,
}) {
  // returns one of:
  //   { ok: true,  canonicalName, candidates }
  //   { ok: false, failureType: 'url_invalid' | 'not_connected' | 'name_mismatch', canonicalName?, candidates?, detail }
}
```

---

## 5. Matcher upgrade in `sendIntroMessage`

Touches `src/linkedin/actions.js` lines ~1424-1445 only.

**Current matcher** (line 1424):
```js
const exact = candidates.find((c) => {
  const t = normalizeName(c.innerText || c.textContent);
  return t === norm || t.startsWith(`${norm} `);
});
```

**Replace with a 3-tier matcher**, attempted in order:

1. **Exact / startsWith** — unchanged. First attempt, fastest, lowest false-positive risk.
2. **Token-prefix match** — split configured `primaryName` on whitespace into tokens. For each token, require some whitespace-separated word in the candidate's normalized text starts with that token. All tokens must match. Example: configured `["sam", "ferrer"]` matches candidate normalized text `"samuel ferrer founder at ortus"` because `"samuel".startsWith("sam") && "ferrer".startsWith("ferrer")`.
3. **Single-candidate fallback** — if the dropdown shows exactly one visible candidate, click it. LinkedIn returning a single suggestion for the typed name is almost always correct, even if our matcher can't prove it.

**Error message upgrade** (replaces line ~1442-1444):
```js
const detail = clickResult.candidateCount === 0
  ? 'recipient-not-in-results (dropdown never opened — confirm 1st-degree connection)'
  : `recipient-not-in-results (${clickResult.candidateCount} suggestions but no match; saw: ${clickResult.preview})`;
```
The `preview` already exists in the current code (line 1422) — now surfaces in every failure log line, not just dropdown-never-opened.

**Pure-helper extraction** (for testability): pull `matchPrimaryCandidate(candidates, configuredName) → { match, reason }` into a pure helper at the top of `actions.js` (or a new `src/linkedin/match-primary.js` to avoid touching actions.js any more than needed). The DOM-dependent dropdown polling stays in `sendIntroMessage`; only the decision logic moves.

---

## 6. Pre-flight orchestrator

`src/preflight-primary.js` exports:

```js
export async function runPreflight({
  activeProfiles,      // [{ profileId, profileName, page }]
  primaryName,
  primaryUrl,
  log,
  overallTimeoutMs = 60_000,
}) {
  // returns { allPassed: bool, results: [{ profileName, ok, failureType?, canonicalName?, candidates?, detail? }] }
}
```

Implementation notes:
- Wraps `verifyPrimaryPerson` calls in `Promise.allSettled` so one profile's crash doesn't tank the others.
- Wraps the whole thing in `Promise.race` against the overall timeout — on timeout, profiles still unfinished are reported as `{ ok: false, failureType: 'timeout' }`.
- Each individual `verifyPrimaryPerson` call has 2 internal retries on transient errors (navigation timeout, network blip) before declaring fail.
- Returns `allPassed: false` if any profile failed for any reason — including timeout. (Per operator decision: hard-block over best-effort.)

---

## 7. Campaign integration

In `src/campaign.js startCampaign()`, after profiles are launched and pages are ready, before the campaign worker loop starts:

```js
if (mode === 'connect_and_introduce') {
  log(`📋 Pre-flight: verifying primary person on ${activeProfiles.length} account(s)…`);
  const preflight = await runPreflight({ activeProfiles, primaryName, primaryUrl, log });
  if (!preflight.allPassed) {
    log(`❌ Pre-flight failed — campaign aborted.`);
    for (const r of preflight.results.filter(x => !x.ok)) {
      log(`   ${r.profileName}: ${r.failureType} — ${r.detail || ''}`);
    }
    // Tear down launched profiles
    await Promise.all(activeProfiles.map(p => closeProfile(p).catch(() => {})));
    campaign.running = false;
    // Surface the failure to the caller via thrown error with structured payload
    const err = new Error('PREFLIGHT_FAILED');
    err.preflight = preflight;
    throw err;
  }
  log(`✓ Pre-flight: primary person verified on ${activeProfiles.length}/${activeProfiles.length} accounts`);
}
```

The thrown `PREFLIGHT_FAILED` error is caught by the HTTP route in `server.js` and returned as:
```http
409 Conflict
{
  "error": "preflight_failed",
  "results": [
    { "profileName": "antonio@…", "ok": false, "failureType": "name_mismatch",
      "canonicalName": "Samuel Ferrer", "candidates": [...] },
    ...
  ]
}
```

---

## 8. UI changes

### 8.1 Wizard — URL becomes required

In `public/index.html`, the Primary Person LinkedIn URL field gets a red asterisk and a `data-required-when="connect_and_introduce"` attribute. In `public/js/app.js startCampaign()`, the existing click-time hard-block (shipped in `6d9c130`) gains a third check: when mode is `connect_and_introduce` AND primary URL is empty, alert + scroll + focus the URL field. Same UX as the existing primary-name check.

### 8.2 Pre-flight modal

Three visual states, matching `public/sketches/preflight-primary-v1.html`:

- **Verifying** — modal with progress bar + per-profile rows. Each row starts at `Pending`, transitions through `Checking` (↻ spinner) to `Verified` (✓ green) or one of the three failure pills. Cancellable via `Cancel` button (cancels the underlying pre-flight via abort signal, tears down profiles).
- **All clear** — green summary banner, all rows ✓, auto-dismisses after 1.5s, campaign begins.
- **Failure** — red summary banner, failed rows show explicit failure type + detail. Failed rows with `failureType: 'name_mismatch'` get a `Use "<canonicalName>"` pill that, on click, updates the wizard's primary-name field and re-runs pre-flight without closing the modal. Modal also has `Cancel` and `Edit primary person` actions; the latter closes the modal and scrolls to the wizard's primary-person section.

### 8.3 Did-you-mean pill behavior

Clicking the `Use "<canonicalName>"` pill:
1. Updates the wizard's Primary Person Name input value.
2. Triggers a `change` event so any wizard validation re-runs.
3. POSTs `/api/campaign/preflight-retry` (or re-runs the original start with the updated name) — the modal stays open, rows reset to `Pending`, the check re-runs.
4. On success → modal transitions to All-clear → campaign starts.

This means the pre-flight orchestrator must be callable both from `startCampaign` AND as a standalone retry. Two callers, one function.

---

## 9. Error handling and edge cases

- **Browser crash mid-pre-flight on one profile.** That profile reports `{ ok: false, failureType: 'crash' }`. Modal lists it. Operator must restart the campaign — we don't auto-relaunch.
- **All profiles pass but campaign-loop fails to start for unrelated reasons** (e.g. sheet fetch fails). Standard error path; pre-flight result already logged so debugging is intact.
- **Operator cancels mid-pre-flight.** Send abort signal to in-flight `verifyPrimaryPerson` calls; close launched profiles; campaign returns to IDLE. Same UI state as if they'd never clicked Start.
- **Pre-flight passes but the in-campaign send still fails on some lead.** Caught by the matcher upgrade (section 5); error message now includes the top 3 candidates seen, surfaced in `data/campaign-log.txt` and the sheet's `Audit Action` column.
- **Pre-flight modal closed by accident (Escape key, click outside).** Treat as Cancel — same teardown.
- **Restored campaign** (Resume / Restore flow): if mode is `connect_and_introduce`, re-run pre-flight on resume just like a fresh launch. Restoring without re-verifying defeats the point.

---

## 10. Tests

### Pure-helper unit tests (`tests/match-primary.test.js`)
- Exact match: configured `"Sam Ferrer"` against candidates `["Sam Ferrer · CEO at X"]` → match.
- StartsWith match: configured `"Sam"` against candidates `["Sam Ferrer · CEO"]` → match.
- Token-prefix match: configured `"Sam Ferrer"` against candidates `["Samuel Ferrer · CEO"]` → match.
- Token-prefix non-match: configured `"Sam Ferrer"` against candidates `["Sam Fernandez · CTO"]` → no match (no token starting with "ferrer").
- Single-candidate fallback: configured `"Sam Ferrer"` against candidates `["John Doe · CFO"]` → match (single candidate, click it). configured `"Sam Ferrer"` against candidates `["John Doe", "Jane Roe"]` → no match (multiple candidates, none match by name).
- Empty candidates → no match.
- Accent normalization: configured `"Jose Maria"` against `["José María Pérez"]` → match.

### Pre-flight orchestrator tests (`tests/preflight-primary.test.js`)
- Mock `verifyPrimaryPerson` returning various results; assert orchestrator aggregates correctly.
- All-pass → `allPassed: true`.
- One fail → `allPassed: false`, results array correct.
- Timeout → unfinished profiles reported as `failureType: 'timeout'`.
- One crash (rejected promise) → captured as `failureType: 'crash'`.

### Manual verification on dev:app
- Launch CC+IC with valid primary → see Verifying modal → All-clear → campaign starts.
- Launch CC+IC with deliberately misspelled name → Failure modal → click did-you-mean pill → re-runs → All-clear.
- Launch CC+IC with deliberately wrong URL → Failure modal with `url_invalid`.
- Launch CC+IC with primary URL that's a real person but not connected on one account → Failure modal with `not_connected`.

---

## 11. Out of scope

- **Multi-recipient compose URL** (`?recipient=A,B`). Possibly cleanest long-term fix — bypass typeahead entirely by passing both publicIds in the URL. Requires research into LinkedIn's current behavior; deferred to a follow-up.
- **Fuzzy name matching beyond token-prefix** (Levenshtein, phonetic). Token-prefix covers the dominant failure modes; deeper fuzzy matching can be added later if needed.
- **Migrating existing campaigns** to require URL. Existing on-disk state from `connect-introduce-back-v2.14` runs already includes `primaryUrl` (optional); if it's empty when a Resume fires, treat as a hard-block and prompt the operator to fill it in via the resume modal.
- **Apps Script changes.** No FIELD_MAP or sheet schema changes needed — pre-flight is entirely client-side.
- **Terminology rename** (e.g. "primary" → "introduced"). Considered and rejected in brainstorm — keeping "primary person" everywhere.

---

## 12. Open questions

None at spec-write time. To be revisited if found during planning.

---

## Appendix A — Files modified

```
NEW   src/linkedin/verify-primary-person.js
NEW   src/preflight-primary.js
NEW   src/linkedin/match-primary.js                       (pure matcher helper)
NEW   tests/match-primary.test.js
NEW   tests/preflight-primary.test.js
EDIT  src/campaign.js                                     (call pre-flight; tear down on fail)
EDIT  src/linkedin/actions.js                             (matcher upgrade only, lines ~1424-1445; call match-primary helper)
EDIT  server.js                                           (return PREFLIGHT_FAILED as 409; add /api/campaign/preflight-retry)
EDIT  public/index.html                                   (URL required; pre-flight modal markup)
EDIT  public/js/app.js                                    (start-campaign URL hard-block; pre-flight modal handlers)
EDIT  public/css/style.css                                (pre-flight modal styles)
```
