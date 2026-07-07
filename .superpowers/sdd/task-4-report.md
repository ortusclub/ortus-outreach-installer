# Task 4 Report: /api/preflight endpoint + server-side launch gate

## Status
DONE

## Commits
- `683fd10` — `feat: preflight gate decision helper (ack token, blocklist always excluded)`
- `ee54024` — `feat: /api/preflight endpoint + server-side launch gate with ack token`

## Test summary
1093 pass / 2 skipped / 0 fail (baseline was 1089; +4 new gate tests, no regressions)

## node --check
Both `server.js` and `src/campaign.js` exit 0.

## Changes made
- `src/preflight-gate.js` (new): `ackFor(findings)` + `decidePreflightGate({findings, ackProvided, ackExpected})` — pure, unit-testable.
- `tests/preflight-gate.test.js` (new): 4 tests covering clean/refuse/ack/stale-ack paths.
- `server.js`: added imports for `lintLeads` and `ackFor`/`decidePreflightGate`; added `_preflightAcks` Map + `_registerAck()`; added `POST /api/preflight` endpoint above `/api/campaign/start`; added pre-flight gate block inside `/api/campaign/start` before `buildCampaignConfig`; added `excludedUrls` field to `buildCampaignConfig` return object.
- `src/campaign.js`: added `excludedUrls = []` to `startCampaign` param destructuring; added normalized-URL exclusion filter producing `_pfRows` before the `_isTarget` pre-filter (avoids reassigning `const rows`); updated skip-count log to use `_pfRows.length`.

---

## Review-fix addendum (2026-07-07)

### Findings addressed

**#1 CRITICAL — queue-only enqueues without gate**
Extracted the `/api/campaign/start` gate block into a shared `runPreflightGate(req, res)` async helper (server.js). Added `if (!await runPreflightGate(req, res)) return;` to `/api/campaign/queue-only` before `buildCampaignConfig`. This gives queue-only the same 409-on-unacked-blockers + `_preflightExcludedUrls` injection that start has.

**#2 IMPORTANT — restoreCampaign loses excludedUrls**
Added `excludedUrls` to the `_lastRunSettings` snapshot in `startCampaign` (src/campaign.js:~1793). It is persisted to `last-run-settings.json` via `writeLastRun`. `restoreCampaign` calls `startCampaign({ ...settings })` which now carries `excludedUrls` forward. The central guard (finding #1) also covers restored campaigns unconditionally.

**#3 IMPORTANT — relaunch route ungated**
No interactive gate added (unattended path, no UI). Added a one-line comment at the route noting the central guard covers blocklist. The central guard in `startCampaign` provides the hard invariant.

**#4 MINOR — scheduler cron ungated**
Same as #3: comment added at the `startCampaign(...)` call in the cron handler; central guard covers this path.

**Central guard (Fix A — covers all 5 paths)**
Added `blocklistExcludedUrls(rows, { linkedinColumn, mode, blocklist })` as a pure exported helper to `src/preflight-lint.js`. It wraps plain row objects as `{rowNumber: i+2, row}` and returns the blocklist-match URLs for cold modes only. In `startCampaign` (src/campaign.js, at the `_pfExcluded` section), the central guard runs `blocklistExcludedUrls` against `readBlocklist()`, unions the result with incoming `excludedUrls`, and filters rows before `_isTarget`. On guard error: logs a warning and calls `pushSoftWarning` — does NOT block the launch. Imports for `readBlocklist` and `blocklistExcludedUrls` added to campaign.js.

**Tests added**
Two new unit tests in `tests/preflight-lint.test.js`:
- `blocklistExcludedUrls: cold mode excludes IBM row` — verifies IBM company row URL is returned for `connect_only`
- `blocklistExcludedUrls: message_only excludes nothing (warm mode)` — verifies warm modes return `[]`

### Test run
`node --test tests/preflight-gate.test.js tests/preflight-lint.test.js tests/blocklist.test.js` → 26 pass / 0 fail
`node --check server.js src/campaign.js` → both exit 0
Full suite → **1095 pass / 2 skipped / 0 fail** (+2 over baseline 1093)

## Concerns / notes
- `rows` in `startCampaign` is `const` — the exclusion filter uses `_pfRows` (new variable) rather than reassigning. `targets = _pfRows.filter(_isTarget)`. Downstream uses of `rows` (resume-reload `newRows`, `_isTarget` closure) are unaffected.
- `delete findings._targets` from the brief was omitted — Task 3 already removed `_targets` from the return object.
- Curl smoke-test skipped — requires live app + real sheet URL; operator verifies in Task 5.
- Queued campaigns bypass the HTTP handler (`runNextFromQueue` → `launchCampaign` direct call), so the gate only fires at enqueue time — matches the plan's intent.

## Final-review fix wave H-1/H-2

### H-1 — Cloud path bypasses the blocklist

**Root cause:** `/api/campaign/start-cloud` called neither `runPreflightGate` nor `blocklistExcludedUrls`; the engine never runs local `startCampaign` so the central guard was silent.

**Fix applied:**
1. `runPreflightGate(req, res)` called immediately after `rejectIfNoOperatorEmail` — same position as the local `/api/campaign/start` path. If it returns false the handler stops.
2. After fetching sheet rows, `blocklistExcludedUrls` + `req.body._preflightExcludedUrls` produce two `Set`s of normalized URLs. Any lead whose URL matches either set is skipped with a `cloudLog` line reporting the count.
3. `normalizeProfileUrl` exported from `src/preflight-lint.js` (the private `normalizeUrl` becomes an alias) so both start-cloud and the existing `normalizeUrl` usages inside the file share one canonical implementation. Imported into `server.js` alongside `blocklistExcludedUrls`.
4. The tab-aware `cloudSheetUrl = withGid(sheetUrl, cloudGid)` is now also used for `fetchSheet`, so H-2's gid fix propagates to the cloud leads array automatically.

### H-2 — Preflight lints the wrong tab

**Root cause:** Client sent only `sheetUrl` (no `sheetGid`); server `runPreflightGate` and `/api/preflight` both called `fetchSheetWithRows(rawSheetUrl)` → first tab always read.

**Fix applied:**
1. `withGid` added to the `import` from `./src/utils.js` in server.js.
2. `runPreflightGate`: computes `resolvedGid` from `req.body.sheetGid`; builds `effectiveUrl = withGid(rawSheetUrl, resolvedGid)`; uses `effectiveUrl` for `fetchSheetWithRows`; sets `gateGidExplicit = /[#&?]gid=/.test(effectiveUrl) || !!resolvedGid`.
3. `/api/preflight`: same pattern — `resolvedGid` from `body.sheetGid`, `effectiveUrl = withGid(sheetUrl, resolvedGid)`, `gidExplicit` derived from `effectiveUrl || resolvedGid`.
4. Client (`public/js/app.js`): `runPreflight` call inside `startCampaign` now includes `sheetGid: body.sheetGid || window._chosenSheetGid || ''`.

### Test commands + output

```
node --check server.js public/js/app.js src/preflight-lint.js
# (no output — clean)

node --test tests/preflight-lint.test.js tests/preflight-gate.test.js tests/blocklist.test.js
# tests 27 | pass 27 | fail 0  (was 26; +1 normalizeProfileUrl unit test)

node --test tests/*.test.js
# tests 1098 | pass 1096 | fail 0 | skipped 2  (was 1095/2/0)
```

### Concerns
- `normalizeProfileUrl` is identical to the private `normalizeUrl` that was already in `preflight-lint.js`; the export is additive, not a behaviour change.
- start-cloud's `runPreflightGate` sees `req.body.sheetGid` via the same field name the local start handler uses — confirmed by reading lines 970–978 of server.js.
- The `cloudSheetUrl` fix (using `withGid` for `fetchSheet` in start-cloud) is a bonus correctness fix not in the original H-1 spec but required for consistency with the gate.
