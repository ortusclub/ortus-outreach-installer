# CC+IC Reliability + Pause-Edit — Design Spec

**Date:** 2026-06-10
**Status:** Approved approach (decisions locked); pending spec review → plan → execution.

Five issues reported by the operator (Antonio), diagnosed against live `campaign.log` + code. This spec is the agreed fix design. Each ships as its own commit on one branch, version-bumped + relaunched per house rules, TDD throughout. **`src/linkedin/outreach.js` and `src/linkedin/actions.js` remain off-limits.**

Sequence: **#2 → #4 → #3 → #5**. (#1 **dropped** per operator decision 2026-06-10 — labels left exactly as-is; no rename, no Apps Script redeploy.)

---

## #2 — False "Connected / Introduction Made" (URGENT)

### Root cause (confirmed)
`computeBulkCheckUpdates` (`src/linkedin/bulk-check-connections.js`) marks a lead accepted if **slug OR URN-token OR first+last NAME** hits a pooled, all-accounts "Recent Connections" set. Two defects compound:
1. **Name matching** → a different person (or a different account's connection) with the same name falsely matches. (`nameToAccounts` built at :109-110, fed into `_matchedAccounts` at :202.)
2. **Unsent-row hole** → when a row's `Sender` is empty, `_assignedConnected = rowSenderNorm ? _matchedAccounts.has(rowSenderNorm) : isMatch` (:207-209) collapses to bare `isMatch`, so any account claims it; `wasInvited` is false (:249) → "Already connected" stamp (:385-401) + intro fires (`sweepingConnected`/`connectedUrls`, :216/:360).

**Vito proof:** abhinay's sweep name-matched "Vito Mansueto" and fired "Introduction Made" at 19:37:41Z; rilany (the assigned sender) didn't send the request until 20:47:05Z — intro fired 70 min *before* the request existed.

### Decision: **Strict ID-only**
Name-only matches are ignored entirely — never stamped, never introduced. Accepted trade: a few genuine acceptances we only have a *name* for (e.g. "withholding URN — profile did not load" rows) won't auto-introduce. Those are exactly the rows we can't prove identity for, so missing > misfiring.

### Fix (all in `src/linkedin/bulk-check-connections.js`)
1. **Remove name from the match keys.** Drop `nameToAccounts` population (:109-110) and its contribution to `_matchedAccounts` (:202). `isMatch` now derives only from slug + URN-token.
2. **Add numeric Membership ID as an additive strong key.** Build `memberNumberToAccounts` from each connection's `memberNumber` (carried through the sidecar/matchSet at :590/:606 and Apps Script :1611-1616). On the row side read the existing numeric `'LinkedIn Membership ID'` column (reuse `readSourceMemberId` from `src/profile-identity.js`). Hard numeric equality → zero new false positives; recovers matches the ACwAA↔ACoAA token-encoding gap drops.
3. **Close the unsent-row hole.** Empty-`Sender` rows may only be stamped/introduced when there is a real `'Connection Request Sent'` (`wasInvited`) **or** a strong-identity hit — never on bare `isMatch`. A row nobody sent can never be auto-stamped accepted or introduced.

### Done looks like
An intro fires only when a real ID (slug, URN-token, or numeric Membership ID) matches a connection owned by an **active sender**, and only for rows actually sent. Name-only and never-sent rows never fire one. A regression test reproducing the Vito case (name-only, cross-account, unsent → no stamp, no intro) passes.

### Tests (write first)
- Vito repro: name-only match on unsent, cross-account row → **no** stamp, **no** `connectedUrls` push.
- Numeric-ID match (no slug/token) → stamped Connected for the correct sender.
- Token match still works (regression of current good path).
- Same-name-different-ID → not matched.

### v2.86.10 preservation (must-hold invariant)
v2.86.10 (`fix(connect): verify captured profile identity`) lives in the same identity neighbourhood. #2 must **reinforce** it, never weaken it:
- **G1 — don't touch `src/profile-identity.js` semantics.** Import `readSourceMemberId` read-only; if a numeric extractor is needed, add a new helper without altering existing exports. All 18 `tests/profile-identity.test.js` cases stay green.
- **G2 — extend, don't replace, the connect-layer guard.** v2.86.10 withholds the URN and downgrades the `already_connected` stamp to a RETRYABLE skip when identity is unverified (`campaign.js:2745`, `:2823-2835`). #2 changes only the bulk-check *matcher*; leave the connect-path guard intact.
- **G3 — the v2.86.10 fingerprint must now also be blocked at the bulk layer.** Add a regression test: a row with EMPTY `'LinkedIn Membership ID'` + no URN token + a matching NAME → **no** stamp, **no** intro (previously the exact false-positive shape, now doubly guarded).
- **G4 — full suite green, not just new tests.** After #2, re-run `tests/profile-identity.test.js`, `tests/bulk-check-connections.test.js`, `tests/idle-bulk-check.test.js`; all must pass. Final integration review explicitly re-verifies v2.86.10 behaviour.

---

## #4 — "Stop everything" leaves "monitoring · 7 days"

### Root cause
The past-card chip reads **persisted schedule files** via `_monitoringForEntry` (`server.js:2954-2962`) → rendered at `app.js:8756-8767`. Neither stop path deletes them: `stopMonitoring()` (`src/campaign.js:3993-4082`) never calls the removers; `stopCampaign({full})` calls them fire-and-forget against possibly-overwritten ids (`:3766-3767`).

### Fix
On **both** stop paths, await removal of reply-check + bulk-check schedule entries for that sheet + profiles (`removeReplySchedules` `src/post-campaign-reply-check.js:331`, `removeBulkSchedules` `src/post-campaign-bulk-check.js:355`), capturing the sheet/profile ids before any reset so removal targets the right entries.

### Done looks like
After "Stop everything" or "Stop monitoring," the past card shows "Stopped" with **no** monitoring chip, the schedule files contain no entries for it, and no further background checks fire.

### Tests
- After stop, schedule files have no entries for the stopped sheet+profiles.
- `_monitoringForEntry` returns `{active:false}` for the stopped entry.

---

## #3 — Logged-out / stuck browsers left open

### Status
Code SIGKILLs on close (`closeProfile` `src/gologin-launcher.js:213-251`), so it *should* shut these. Logs show ~2 opened-but-not-closed overnight; the confirmed culprit (`christian.saguid`, session-expired 20:15:40Z) was frozen on the Orbita "Something went wrong" dialog. Root cause of the *failed kill* is not yet proven — so this fix is part safety-net, part diagnostic. No guessing a single "fix."

### Fix
1. **End-of-campaign orphan sweep:** after "Closing all browsers", force-kill any leftover Orbita/Chromium process belonging to **our** GoLogin profiles (match by profile dir / id). Never touch a browser the operator opened manually (mirror the `wasAlreadyRunning` guard).
2. **Instrumentation:** log the reason whenever a close is skipped or `killBrowser` fails, so the next occurrence reveals the real failure mode.

(#4's fix removes the "looks like it's still monitoring" half of the report.)

### Done looks like
No orphaned Orbita windows after a campaign ends; every skipped/failed close is logged with an actionable reason.

### Tests
- Orphan-sweep kills a leftover profile process; leaves a manually-opened browser untouched (mocked process layer).

---

## #5 — Edit while paused (templates, daily limit, cadence)

### Feasibility (verified)
Pause parks the send loop at the lead boundary; the loop reads settings from **local closures**, so today only bench/un-bench is live. Conversion difficulty: daily limit & cadence = trivial read-source swaps; templates = medium (re-normalize per-lead). Add-account / new-leads = restart-only (fixed worker pool, single sheet fetch) — **out of scope**.

### Fix
1. **Daily limit:** switch the 4 gating reads (`src/campaign.js:2293, 2310, 2876, 2988`) from local `dailyLimit` → `campaign.dailyLimit`; add a setter route.
2. **Cadence:** switch the send-loop trigger (`src/campaign.js:2902`, `:3307`) from local → `campaign.checkIntervalMinutes` (re-apply `clampCadenceMinutes`); add a clamped setter. (Monitoring already reads it live.)
3. **Templates:** move the `tpl` normalization (`src/campaign.js:1419-1453`) into a helper called per-lead from `campaign.templates`; switch the param reads at `:2618`, `:2972`, `:2133/:2910`; add a setter route.
4. **UI:** an "Edit" panel enabled **only while paused** (near the pause handlers `app.js:~3685`), writing to the running campaign; values take effect on Resume. Add-account / new-leads shown as restart-only.

### Done looks like
Pause → edit template / limit / cadence → Resume → the running campaign uses the new values (proven by a test asserting the loop reads `campaign.<field>` live). Unsafe edits stay restart-only with a clear note.

### Tests
- Loop reads `campaign.dailyLimit` / `campaign.checkIntervalMinutes` / re-normalized templates live (not snapshot).
- Setter routes clamp/validate and reject when not paused (or no campaign).

---

## #1 — Clarify the three "connected" labels — **DROPPED (2026-06-10)**

> Operator decision: leave labels exactly as-is for now; ship only the 4 functional fixes. The analysis below is retained for the record if it's ever revisited.

### Blast-radius finding (changes the approach)
The status strings are **not** display-only — they are load-bearing in ~150 comparison sites:
- Auto-intro / auto-DM **firing gates**: `currentCc === 'Connected'` (`auto-intro.js:43/425`, `auto-dm.js:40/295`).
- **Idempotency** guards in the matcher: `cs === 'Already Connected'` etc. (`bulk-check-connections.js:330/356/423/454`).
- Monitoring / stage logic (`campaign.js:447/453`).
- Apps Script **green colour** keyed on the exact literal: `{ val: 'Already Connected', state: 'connected' }` (`google-apps-script.js:210`) → renaming stops the green, and per CLAUDE.md **every operator must repaste + redeploy** the Apps Script.

Renaming the canonical strings (esp. a dynamic "(other account: X)" suffix, which no exact-match guard or colour rule catches) is a cross-cutting refactor through the intro-firing logic and v2.86.10's neighbourhood — high risk, cosmetic payoff. **Re-scoped (operator to choose — see review questions).**

### Decision: **display-only, strings frozen** (recommended)
Leave every internal canonical string exactly as-is (so all guards, idempotency, intro/DM gates, v2.86.10 logic, and Apps Script formatting keep working untouched). Reduce confusion *without* touching the engine:
- Add a short legend / tooltip in the dashboard explaining the three states in plain English.
- Optionally surface the already-reassigned `Sender` next to a cross-account "Already Connected" so the operator sees *which* account — data that already exists, no new status string, no Apps Script change.

Full canonical-string consolidation (~150-site refactor + Apps Script redeploy for all operators) is deferred to its own spec if ever wanted; not bundled with the reliability fixes.

### Done looks like
Operator can tell the three states apart at a glance (legend/tooltip + visible connected-account), with **zero** changes to status strings, intro gates, or Apps Script formatting. v2.86.10 untouched.

---

## Cross-cutting
- One branch; per-issue commits; `node --test` green at each step; version patch-bump before each relaunch.
- **Coordinate relaunch:** relaunching `dev:app` kills a running campaign — confirm none is live before each relaunch (ONE-campaign rule).
- Apps Script (`google-apps-script.js`) is the deployed bridge — label/field changes there require the operator to redeploy; flag any such change explicitly.
