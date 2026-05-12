# Multi-Account Rotation + Connect+IntroBack UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the multi-account rotation + Connect+IntroBack UX update in one feature branch: 5-min in-campaign bulk-check (in-batch + idle), header rename to `Connection Request Status` / `Connection Accepted Status`, strict per-mode column visibility with legacy-v1 columns hidden, dual-stamp avoidance for auto-introed rows, and the Throughput knob fix.

**Architecture:** Two-phase model — Phase 1 (sending) uses a 5-min cooldown for both in-batch and idle bulk-checks per (sheet, profile); idle profiles briefly reopen browsers via `browserSemaphore` to check, then close. Phase 2 (post-sending) uses the existing `src/post-campaign-bulk-check.js` scheduler unchanged (verification only). Header rename rides on the Apps Script's existing `COLUMN_RENAMES` migration mechanism so operators don't lose data.

**Tech Stack:** Node ≥22, Express 4, GoLogin SDK 2.2.8, puppeteer-core ^22.15.0, Electron ^33.4.11. Test runner: `node --test` (no Jest, no Vitest, per CLAUDE.md). Apps Script V8 runtime.

**Spec:** `docs/superpowers/specs/2026-05-12-multi-account-rotation-design.md`

**Operator coordination required:** Task 1 commits Apps Script changes that every operator (Antonio, Sam, Katrina) must redeploy from their personal Google account before downstream JS-side commits behave correctly. Antonio handles the redeploy coordination.

---

## File Structure

| File | Responsibility | Touch type |
|---|---|---|
| `ortus-outreach-sheets-bridge.gs` | Header rename via `COLUMN_RENAMES`; updated `MODE_COLUMNS_V2`; new `LEGACY_COLUMNS_TO_HIDE_V2`; updated `FIELD_MAP`; extended `handlePrepareSheet` | Modify |
| `src/linkedin/bulk-check-connections.js` | New `suppressAcceptedStamp` arg; legacy-header back-compat for accepted column lookup | Modify |
| `src/campaign.js` | New constants (`IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS`, `IDLE_CAMPAIGN_MIN_DURATION_MS`); per-mode interval at the in-batch trigger; new `runIdleBulkCheck` helper; idle trigger in worker-pool loop; column-name reference updates | Modify |
| `src/linkedin/auto-intro.js` | Verification only — no expected code change | Read |
| `src/post-campaign-bulk-check.js` | Verification only — no expected code change | Read |
| `public/js/app.js` | One-line fix at line 1474 — show daily-limit knob for `connect_and_introduce` | Modify |
| `tests/bulk-check-connections.test.js` | New test file for `suppressAcceptedStamp` behavior | Create |
| `tests/idle-bulk-check.test.js` | New test file for idle bulk-check gates + `runIdleBulkCheck` helper | Create |
| `tests/build-sheet-data-for-action.test.js` | Extend with `connect_and_introduce` action coverage | Modify |

---

## Task 1: Apps Script — header rename + legacy-hide + Connected → always-hidden

**Files:**
- Modify: `ortus-outreach-sheets-bridge.gs`

- [ ] **Step 1: Add header rename entries to `COLUMN_RENAMES`**

Locate the existing `COLUMN_RENAMES` array (around line 150 of the `.gs` file). Add two entries at the end:

```js
var COLUMN_RENAMES = [
  { from: 'Status',            to: 'Connection Request Status' },
  { from: 'Connection Status', to: 'Connection Request Status' },
  { from: 'CC',                to: 'Connected Status' },
  { from: 'Date',              to: 'Date of Last Action' },
  { from: 'Time',              to: 'Time of Last Action' },
  { from: 'Connected', to: 'Connected' },
  // NEW: v2.14 header rename — clarifies request vs acceptance.
  { from: 'Connection Status', to: 'Connection Request Status' },
  { from: 'Check Status',      to: 'Connection Accepted Status' },
];
```

Note: the existing `{ from: 'Connection Status', to: 'Connection Request Status' }` rename was for the OLD pre-v2 schema. The new entry duplicates it — harmless because the migration is idempotent (already-migrated columns are skipped on next pass via the `headers.indexOf(r.to) !== -1` guard).

- [ ] **Step 2: Update `MODE_COLUMNS_V2`**

Replace the entire `MODE_COLUMNS_V2` block (around lines 74-92) with:

```js
var MODE_COLUMNS_V2 = {
  connect_only:          ['Connection Request Status'],
  check_status:          ['Connection Accepted Status'],
  message_only:          ['DM Status', 'Connection Accepted Status'],
  introduce_back:        ['Intro Status', 'Connection Accepted Status'],
  open_profile_only:     ['OP Status', 'Open Profile'],
  inmail_only:           ['InM Status'],
  // Connect + Introduce Back: full cold-lead flow with three mode columns.
  // Auto-intro fires when bulk-check detects acceptance — Introduction Status
  // becomes the single source of truth for those rows (Connection Accepted
  // Status stays blank to avoid dual-stamping, per the operator spec).
  connect_and_introduce: ['Connection Request Status',
                          'Connection Accepted Status',
                          'Introduction Status']
};
```

Two behavioral changes here: (1) `Connected` is dropped from every visible mode set (it moves to always-hidden in Step 3), and (2) the renamed headers replace the old names everywhere.

- [ ] **Step 3: Add `Connected` to `ALWAYS_HIDDEN_BY_DEFAULT_V2`**

Replace `ALWAYS_HIDDEN_BY_DEFAULT_V2` (around lines 64-68) with:

```js
var ALWAYS_HIDDEN_BY_DEFAULT_V2 = [
  'Last Action',
  'LinkedIn URN',
  'LinkedIn Membership ID',
  'Connected'
];
```

The bot still writes `connectedAlready: 'Yes'` to the `Connected` column for downstream tooling, but operators don't see it by default.

- [ ] **Step 4: Add `LEGACY_COLUMNS_TO_HIDE_V2` constant**

Add this constant right after `ALWAYS_HIDDEN_BY_DEFAULT_V2` (around line 69):

```js
// Pre-v2 column headers from the old `ensureColumns` schema. Every
// `prepareSheet` call hides these when found on the sheet — never deletes
// (preserves historical data per operator rule). Operator can unhide
// manually if they need to inspect old runs.
var LEGACY_COLUMNS_TO_HIDE_V2 = [
  'OP', 'Message', 'InMail', 'Account Used',
  'Reply', 'Reply At', 'Reply Preview'
];
```

- [ ] **Step 5: Extend `handlePrepareSheet` to hide legacy columns**

Find the existing step in `handlePrepareSheet` that hides `ALWAYS_HIDDEN_BY_DEFAULT_V2` columns (around lines 516-521 of current file — the loop that calls `sheet.hideColumns` for each entry in `ALWAYS_HIDDEN_BY_DEFAULT_V2`). Add this block immediately AFTER it:

```js
// Step 4b: hide pre-v2 legacy columns when found on the sheet
LEGACY_COLUMNS_TO_HIDE_V2.forEach(function(col) {
  var idx = headers.indexOf(col);
  if (idx === -1) return;
  sheet.hideColumns(idx + 1);
  if (hidden.indexOf(col) === -1) hidden.push(col);
});
```

- [ ] **Step 6: Update `FIELD_MAP` destination headers**

In the `FIELD_MAP` object (around lines 206-238), update two entries:

```js
var FIELD_MAP = {
  // ... existing entries unchanged ...
  status:          'Connection Request Status',    // (already this — no change needed if it already matched)
  cc:              'Connected Status',              // legacy — kept for back-compat with v1 sheets
  // ... other unchanged entries ...
  connectionStatus:  'Connection Request Status',   // was 'Connection Status' — update destination
  // ... unchanged ...
  checkStatus:       'Connection Accepted Status',  // was 'Check Status' — update destination
  // ... unchanged ...
};
```

Specifically the only changes are: `connectionStatus` maps to `'Connection Request Status'` (was `'Connection Status'`), and `checkStatus` maps to `'Connection Accepted Status'` (was `'Check Status'`). Every other field-name entry is unchanged. The bot calls `data.connectionStatus = '…'` and `data.checkStatus = '…'` — those field names stay constant, only the destination column header shifts.

- [ ] **Step 7: Smoke-test the Apps Script change (manual)**

Deploy the updated `.gs` from Antonio's Google account:
1. Open the central Ortus sheet at `https://docs.google.com/spreadsheets/d/1YL-sa8OnMs-VwNKcIe75TrUdzFTvYKeezxX-RUuAeBM`
2. Extensions → Apps Script
3. Replace all code with the updated `.gs` content
4. Deploy → Manage Deployments → Edit (pencil icon) → New Version → Deploy
5. Copy the new web app URL — must match the URL in Antonio's `.env`'s `SHEETS_WEBAPP_URL` (URL stays the same for redeployments of an existing deployment, but verify)

Then run a smoke test against a fresh test sheet:

```bash
curl -L -X POST "$SHEETS_WEBAPP_URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"prepareSheet","sheetId":"<TEST_SHEET_ID>","gid":"0","mode":"connect_and_introduce"}'
```

Expected response:
```json
{
  "success": true,
  "mode": "connect_and_introduce",
  "added": ["Stage","Sender","Date of Last Action","Time of Last Action","LinkedIn URN","LinkedIn Membership ID","Last Action","Connection Request Status","Connection Accepted Status","Introduction Status"],
  "hidden": ["Last Action","LinkedIn URN","LinkedIn Membership ID","Connected"],
  "shown": ["Connection Request Status","Connection Accepted Status","Introduction Status"]
}
```

Then visually verify in the sheet: the three mode columns are visible at the end, `Last Action` / `LinkedIn URN` / `LinkedIn Membership ID` / `Connected` are hidden (look for the column-letter gap), and any legacy columns from earlier runs (if any) are also hidden.

- [ ] **Step 8: Commit**

```bash
git add ortus-outreach-sheets-bridge.gs
git commit -m "$(cat <<'EOF'
Apps Script: rename status headers + hide legacy v1 columns

Connection Status → Connection Request Status, Check Status →
Connection Accepted Status (via COLUMN_RENAMES migration). MODE_COLUMNS_V2
updated to drop Connected from visible sets; Connected joins always-hidden.
New LEGACY_COLUMNS_TO_HIDE_V2 + handlePrepareSheet step 4b hides OP/Message/
InMail/Account Used/Reply* on every prepareSheet call.

Existing sheets auto-migrate on first prepareSheet call after operator
redeploys this script in their personal Google account.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Pause for operator coordination**

After commit, STOP. Tell Antonio:

> "Apps Script committed. Coordinate redeploy with Sam + Katrina before I move to Task 2 — every operator must paste the new `.gs` content into their personal Apps Script editor and redeploy from their account. Existing sheets will auto-migrate the renamed headers via COLUMN_RENAMES on first prepareSheet call. Tell me when redeploys are confirmed."

Do not proceed to Task 2 until Antonio confirms.

---

## Task 2: Throughput knob — show for `connect_and_introduce`

**Files:**
- Modify: `public/js/app.js:1474`

- [ ] **Step 1: Make the one-line change**

Open `public/js/app.js` and find line 1474:

```js
const isConnectMode = (mode === 'connect_only');
```

Replace with:

```js
const isConnectMode = (mode === 'connect_only' || mode === 'connect_and_introduce');
```

- [ ] **Step 2: Manual UI verify (per CLAUDE.md rule #2 — auto-relaunch dev:app)**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Wait ~10s for the Electron window to open. Then in the app:
1. Select **Connect + Introduce Back** in the campaign-mode dropdown.
2. Open the "4. Throughput" section.
3. Expected: "Connections per account per day" knob visible at the top with the value `50`, +/− ticker buttons, "invites / account" suffix label, the LinkedIn-cap explainer text underneath. "Parallel accounts" row below. "+ Advanced" disclosure collapsed by default.

Compare against the Connect Only mode — they should look identical structurally.

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "$(cat <<'EOF'
UI: show daily-limit knob in Throughput for Connect + Introduce Back

Connect + Introduce Back sends connection requests and is subject to the
same ~100/account/week LinkedIn cap as Connect Only. Surfacing the same
knob lets operators tune connections-per-account-per-day for this mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `bulkCheckConnections` — add `suppressAcceptedStamp` flag (TDD)

**Files:**
- Create: `tests/bulk-check-connections.test.js`
- Modify: `src/linkedin/bulk-check-connections.js`

- [ ] **Step 1: Write the failing test for `suppressAcceptedStamp`**

The challenge: `bulkCheckConnections` takes a Puppeteer `page` and makes Voyager API calls — hard to unit-test directly. Instead, extract the pure-function core that takes the connections list + rows + flag and returns `{ updates, connectedUrls, diag }`. That's testable.

Create `tests/bulk-check-connections.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates } from '../src/linkedin/bulk-check-connections.js';

const baseRow = (overrides = {}) => ({
  'First Name': 'Jane',
  'Last Name': 'Doe',
  'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
  'Connection Request Status': 'Connection Request Sent',
  'Connected Status': '',
  ...overrides,
});

const baseConns = [
  { firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111' },
];

const stillPendingLabel = 'Still Pending (2026-05-12 10:00)';
const linkedinColumn = 'LinkedIn URL';

test('suppressAcceptedStamp=false: matched URL gets cc + connectedAlready in updates', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 1);
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match, 'matched URL should be in updates');
  assert.equal(match.cc, 'Connected');
  assert.equal(match.connectedAlready, 'Yes');
});

test('suppressAcceptedStamp=true: matched URL returned in connectedUrls but NOT in updates', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: true }
  );
  assert.equal(connectedUrls.length, 1, 'connectedUrls preserved');
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(match, undefined, 'matched URL stamp suppressed from updates');
});

test('suppressAcceptedStamp=true: still-pending rows STILL get stamped', () => {
  const pendingRow = baseRow({
    'First Name': 'Bob',
    'Last Name': 'Smith',
    'LinkedIn URL': 'https://linkedin.com/in/bob-smith',
  });
  const { updates } = computeBulkCheckUpdates(
    [pendingRow], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: true }
  );
  const pendingStamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/bob-smith');
  assert.ok(pendingStamp, 'still-pending row should be stamped regardless of flag');
  assert.equal(pendingStamp.cc, stillPendingLabel);
});

test('back-compat: recognizes "Connection Accepted Status" as already-Connected header', () => {
  const rows = [baseRow({ 'Connection Accepted Status': 'Connected', 'Connected Status': '' })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  // Row already shows Connected via the NEW header — should be skipped (no re-stamp).
  assert.equal(connectedUrls.length, 0, 'rows already marked Connected via new header are skipped');
});
```

- [ ] **Step 2: Run the test — it should fail**

```bash
cd /Users/antoniovarlese/ortus-gologin-clone
node --test tests/bulk-check-connections.test.js
```

Expected: FAIL with `SyntaxError` or `TypeError: computeBulkCheckUpdates is not a function` because the export doesn't exist yet.

- [ ] **Step 3: Refactor — extract `computeBulkCheckUpdates` from `bulkCheckConnections`**

Open `src/linkedin/bulk-check-connections.js`. Currently the row-matching + updates-building logic lives inline in `bulkCheckConnections` (around lines 100-200). Extract that into a pure exported helper.

After the existing imports (line 20), add:

```js
/**
 * Pure helper — given the fetched connections + the sheet rows, decide
 * which rows get Connected stamps vs Still Pending stamps. Extracted from
 * bulkCheckConnections so it can be unit-tested without spinning up a
 * Puppeteer page.
 *
 * @param {object[]} rows - sheet rows (from fetchSheet)
 * @param {object[]} conns - Voyager connections array
 * @param {string} linkedinColumn - operator-specified URL column name (or '')
 * @param {string} stillPendingLabel - timestamped "Still Pending" stamp value
 * @param {object} opts
 * @param {boolean} [opts.suppressAcceptedStamp=false] - when true, matched
 *   URLs are returned in connectedUrls but their cc/connectedAlready writes
 *   are omitted from the updates array
 * @returns {{ updates: object[], connectedUrls: string[], diag: object }}
 */
export function computeBulkCheckUpdates(rows, conns, linkedinColumn, stillPendingLabel, opts = {}) {
  const { suppressAcceptedStamp = false } = opts;

  // Build matching sets (same logic as before)
  const connectedSlugs = new Set();
  const connectedMemberIds = new Set();
  const connectedNames = new Set();
  for (const c of conns) {
    if (c.publicId) connectedSlugs.add(c.publicId.toLowerCase());
    const mid = _memberIdFromAny(c.urn) || _memberIdFromAny(c.publicId);
    if (mid) connectedMemberIds.add(mid);
    const nameKey = `${(c.firstName || '').toLowerCase().trim()} ${(c.lastName || '').toLowerCase().trim()}`.trim();
    if (nameKey && nameKey !== ' ') connectedNames.add(nameKey);
  }

  const updates = [];
  const connectedUrls = [];
  let dbgRowsScanned = 0, dbgWithUrl = 0, dbgWithCRS = 0;
  let dbgAlreadyConnected = 0, dbgAlreadyDeclined = 0, dbgPidMatched = 0;

  for (const row of rows) {
    dbgRowsScanned++;
    const url = _extractLinkedInUrl(row, linkedinColumn);
    if (!url) continue;
    dbgWithUrl++;

    // Accepted-status lookup includes both old (Connected Status / CC) and
    // new (Connection Accepted Status) headers for back-compat across the
    // rename window.
    const cs = (
      row['Connection Accepted Status'] || row['connection accepted status']
      || row['Check Status'] || row['check status']
      || row['Connected Status']  || row['connected status']
      || row['CC'] || row['cc'] || ''
    ).toString().trim();
    if (cs === 'Connection Declined') { dbgAlreadyDeclined++; continue; }

    const slug = _publicIdFromUrl(url);
    const rowUrn = (row['LinkedIn URN'] || row['linkedin urn'] || '').toString();
    const memberId = _memberIdFromAny(rowUrn) || _memberIdFromAny(url);
    const firstName = (row['First Name'] || row['first name'] || row['firstName'] || '').toString().toLowerCase().trim();
    const lastName  = (row['Last Name']  || row['last name']  || row['lastName']  || '').toString().toLowerCase().trim();
    const nameKey = `${firstName} ${lastName}`.trim();

    const isMatch = (slug && connectedSlugs.has(slug))
      || (memberId && connectedMemberIds.has(memberId))
      || (nameKey && nameKey !== ' ' && connectedNames.has(nameKey));

    if (isMatch) {
      dbgPidMatched++;
      if (cs === 'Connected') { dbgAlreadyConnected++; continue; }
      connectedUrls.push(url);
      if (!suppressAcceptedStamp) {
        updates.push({ linkedinUrl: url, cc: 'Connected', connectedAlready: 'Yes' });
      }
      continue;
    }

    // Not in recent connections — stamp "Still Pending" if the bot invited.
    const requestStatus = (
      row['Connection Request Status'] || row['connection request status']
      || row['Connection Status']        || row['connection status']
      || row['Status'] || row['status'] || ''
    ).toString().trim();
    if (requestStatus !== 'Connection Request Sent') continue;
    dbgWithCRS++;
    updates.push({ linkedinUrl: url, cc: stillPendingLabel });
  }

  return {
    updates,
    connectedUrls,
    diag: {
      rowsScanned: dbgRowsScanned,
      withUrl: dbgWithUrl,
      withCRS: dbgWithCRS,
      alreadyConnected: dbgAlreadyConnected,
      alreadyDeclined: dbgAlreadyDeclined,
      pidMatched: dbgPidMatched,
      slugs: connectedSlugs.size,
      memberIds: connectedMemberIds.size,
      names: connectedNames.size,
    },
  };
}

// Internal helpers — exposed for use by computeBulkCheckUpdates above.
function _publicIdFromUrl(url) {
  if (!url) return '';
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase().trim() : '';
}
function _memberIdFromAny(value) {
  if (!value) return '';
  const m = String(value).match(/(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}
```

Inside `computeBulkCheckUpdates`, where the code reads `_extractLinkedInUrl(row, linkedinColumn)`, replace those calls with `extractLinkedInUrl(row, linkedinColumn)` — that function is already imported at the top of the file (line 20: `import { extractLinkedInUrl } from '../campaign.js'`). Drop the `_extractLinkedInUrl` helper.

Note: the existing inline `publicIdFromUrl` and `memberIdFromAny` functions at the top of `bulk-check-connections.js` stay (used elsewhere in the module). The `_`-prefixed helpers (`_publicIdFromUrl`, `_memberIdFromAny`) inside `computeBulkCheckUpdates` are duplicates so the pure function can be tested without side-effecting imports — you can either (a) keep the duplicates and accept the small DRY violation, or (b) export the existing top-level helpers and reuse them. Choice (b) is cleaner — make `publicIdFromUrl` and `memberIdFromAny` exported (add `export` to their declarations) and remove the `_`-prefixed duplicates inside `computeBulkCheckUpdates`, calling the originals instead.

- [ ] **Step 4: Update `bulkCheckConnections` to call the new helper**

Replace the body of the existing `bulkCheckConnections` function's row-matching block (roughly lines 100-200 of the current file) with:

```js
// After the existing fetchSheet + stillPendingLabel construction:

const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
  rows,
  conns,
  linkedinColumn,
  stillPendingLabel,
  { suppressAcceptedStamp: opts.suppressAcceptedStamp === true }
);

const diagSummary = `scanned=${diag.rowsScanned}, withUrl=${diag.withUrl}, slugs=${diag.slugs}, memberIds=${diag.memberIds}, names=${diag.names}, pidMatched=${diag.pidMatched}, alreadyConnected=${diag.alreadyConnected}, alreadyDeclined=${diag.alreadyDeclined}, stamped=${diag.withCRS}`;
console.log(`[bulk-check] diag: ${diagSummary}`);

if (updates.length === 0) {
  return { matched: 0, fetched: conns.length, diag: diagSummary, connectedUrls };
}

try {
  await batchUpdateSheet(sheetUrl, updates);
} catch (err) {
  return { matched: 0, fetched: conns.length, error: `batch-update: ${err.message}`, diag: diagSummary };
}

const matchedCount = connectedUrls.length;
const pendingCount = updates.filter((u) => u.cc !== 'Connected').length;
return { matched: matchedCount, fetched: conns.length, stamped: pendingCount, diag: diagSummary, connectedUrls };
```

And update the function signature to accept `opts`:

```js
export async function bulkCheckConnections(page, sheetUrl, linkedinColumn, pName, opts = {}) {
  // existing body, with the refactored block above replacing the inline matching loop
}
```

The `opts` arg is OPTIONAL. Existing call sites that don't pass it continue to work (defaults to `suppressAcceptedStamp: false`).

- [ ] **Step 5: Run the tests — should now pass**

```bash
node --test tests/bulk-check-connections.test.js
```

Expected: 4 tests pass.

- [ ] **Step 6: Run the full test suite to confirm no regressions**

```bash
node --test tests/*.test.js
```

Expected: all tests pass (existing tests don't depend on the refactor since they don't go through bulkCheckConnections).

- [ ] **Step 7: Commit**

```bash
git add tests/bulk-check-connections.test.js src/linkedin/bulk-check-connections.js
git commit -m "$(cat <<'EOF'
bulk-check: add suppressAcceptedStamp flag + extract pure helper

Extracts the matching loop into computeBulkCheckUpdates() so it can be
unit-tested without a Puppeteer page. New opts.suppressAcceptedStamp flag:
when true, matched URLs are returned in connectedUrls but their
cc/connectedAlready writes are omitted from the batch update — letting
callers route those rows to runAutoIntros instead, which writes
Introduction Status as the single source of truth.

Accepted-status row lookup now recognizes both legacy headers
(Connected Status / CC) and the new "Connection Accepted Status" name
to bridge the rename window.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: campaign.js — new constants + per-mode in-batch interval + `suppressAcceptedStamp` wiring

**Files:**
- Modify: `src/campaign.js` (around line 50 for constants, line 2050 for the in-batch trigger)

- [ ] **Step 1: Add the new constants**

In `src/campaign.js`, find the existing `BULK_CHECK_FILE` declaration (around line 52). Add the new constants RIGHT BEFORE it:

```js
// v2.14 — per-mode bulk-check cadence. connect_and_introduce mode lowers
// the in-campaign cooldown from 6h → 5 min so acceptances detected mid-run
// can trigger intro DMs before the campaign ends. Other modes keep the 6h
// floor via BULK_CHECK_INTERVAL_MS below.
const IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Idle-account bulk-checks only fire for campaigns that have been running
// long enough to be worth optimizing. Short campaigns rely on the in-batch
// trigger alone.
const IDLE_CAMPAIGN_MIN_DURATION_MS = 30 * 60 * 1000;
```

The existing `BULK_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000` constant stays — it's the legacy default for modes other than `connect_and_introduce`.

- [ ] **Step 2: Update the in-batch trigger to use per-mode interval + suppressAcceptedStamp**

Find the existing block in `src/campaign.js` around line 2044-2081 (the `if (mode === 'connect_and_introduce' && result.action === 'connection_sent')` block). Replace it with:

```js
if (mode === 'connect_and_introduce' && result.action === 'connection_sent') {
  try {
    const _sheetId = _extractSheetIdFromUrl(sheetUrl);
    const cooldown = await readBulkCheckCooldown();
    const _key = bulkCheckKey(_sheetId, profileId);
    const last = cooldown[_key] || 0;
    // v2.14: per-mode interval — 5 min for connect_and_introduce (was 6h).
    if (Date.now() - last >= IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS) {
      log(`  📡 [${pName}] In-batch bulk Connection Status check (5-min cooldown elapsed)…`);

      // Dual-stamp avoidance: when primary fields are configured, the
      // auto-intro will fire for newly-Connected rows — suppress the
      // Connection Accepted Status stamp for those so Introduction Status
      // is the single source of truth.
      const willAutoIntro = !!(templates?.primaryName && templates?.primaryIntroBody);

      const r = await bulkCheckConnections(page, sheetUrl, linkedinColumn, pName, {
        suppressAcceptedStamp: willAutoIntro,
      });
      if (r.error) {
        log(`  ⚠ [${pName}] Bulk check: ${r.error}`);
      } else {
        const stamped = r.stamped || 0;
        log(`  📡 [${pName}] Bulk check: ${r.matched} marked Connected, ${stamped} marked Still Pending (of ${r.fetched} recent connections fetched)`);
      }
      cooldown[_key] = Date.now();
      await writeBulkCheckCooldown(cooldown);

      if (willAutoIntro && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
        await runAutoIntros({
          page,
          profileId,
          profileName: pName,
          sheetUrl,
          linkedinColumn,
          connectedUrls: r.connectedUrls,
          primaryName: templates.primaryName.trim(),
          primaryIntroBody: templates.primaryIntroBody.trim(),
          primaryUrl: (templates.primaryUrl || '').trim(),
          introTitle: templates.introTitle || 'Introduction: {first name} <> {intro name}',
          log,
        });
      }
    }
  } catch (err) {
    log(`  ⚠ [${pName}] Bulk check threw: ${err.message}`);
  }
}
```

Two behavior changes here vs. the existing code:
1. Cooldown comparison uses `IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS` (5 min) instead of `BULK_CHECK_INTERVAL_MS` (6 h).
2. `suppressAcceptedStamp: willAutoIntro` is passed in; the `runAutoIntros` call is gated on `willAutoIntro` so when primary fields are missing, the stamps go through normally (no dual-stamp because no intro fires).

- [ ] **Step 3: Run the test suite**

```bash
node --test tests/*.test.js
```

Expected: all tests pass. No new tests in this task — the in-batch trigger is integration-level behavior verified manually.

- [ ] **Step 4: Auto-relaunch dev:app (CLAUDE.md rule #2)**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js
git commit -m "$(cat <<'EOF'
campaign: 5-min in-batch bulk-check for connect_and_introduce + dual-stamp avoidance

Lowers in-batch bulk-check cooldown from 6h → 5 min specifically for
connect_and_introduce mode so acceptances detected mid-campaign can
trigger intro DMs before the run ends. Other modes keep the 6h interval
via the unchanged BULK_CHECK_INTERVAL_MS constant.

When the campaign has a primary person + intro body configured, passes
suppressAcceptedStamp=true to bulkCheckConnections so newly-Connected
rows skip the Connection Accepted Status stamp — runAutoIntros then
writes Introduction Status as the single source of truth for that row.
When primary fields are missing (auto-intro can't fire), stamps go
through normally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `runIdleBulkCheck` helper (TDD)

**Files:**
- Create: `tests/idle-bulk-check.test.js`
- Modify: `src/campaign.js`

The helper has tight coupling to module-level state (`sessions`, `weeklyLimited`, `browserSemaphore`, `readBulkCheckCooldown`, etc.). Rather than mock all of that, extract a pure "should I fire?" predicate that's testable, and keep the side-effecting helper integration-level.

- [ ] **Step 1: Write the failing test for the predicate**

Create `tests/idle-bulk-check.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFireIdleBulkCheck } from '../src/campaign.js';

const baseInput = {
  mode: 'connect_and_introduce',
  campaignStartTime: Date.now() - (45 * 60 * 1000), // 45 min ago — past 30-min gate
  profileBrowserOpen: false,
  profileWeeklyLimited: false,
  semaphoreAvailable: 1,
  lastBulkCheckAt: Date.now() - (6 * 60 * 1000),    // 6 min ago — past 5-min cooldown
  now: Date.now(),
};

test('fires when all gates pass', () => {
  assert.equal(shouldFireIdleBulkCheck(baseInput), true);
});

test('skips when mode is not connect_and_introduce', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput, mode: 'connect_only' }), false);
});

test('skips when campaign uptime < 30 min', () => {
  const input = { ...baseInput, campaignStartTime: Date.now() - (20 * 60 * 1000) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('skips when profile browser is open (in-batch trigger owns it)', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput, profileBrowserOpen: true }), false);
});

test('skips when profile is parked permanently (weeklyLimited)', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput, profileWeeklyLimited: true }), false);
});

test('skips when semaphore has no available slot', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput, semaphoreAvailable: 0 }), false);
});

test('skips when cooldown not elapsed (5-min floor)', () => {
  const input = { ...baseInput, lastBulkCheckAt: Date.now() - (2 * 60 * 1000) }; // 2 min ago
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('fires when cooldown elapsed by exactly the floor (boundary)', () => {
  const input = { ...baseInput, lastBulkCheckAt: baseInput.now - (5 * 60 * 1000) }; // exactly 5 min
  assert.equal(shouldFireIdleBulkCheck(input), true);
});
```

- [ ] **Step 2: Run — should fail**

```bash
node --test tests/idle-bulk-check.test.js
```

Expected: FAIL with `shouldFireIdleBulkCheck is not a function`.

- [ ] **Step 3: Implement `shouldFireIdleBulkCheck` in campaign.js**

Add this exported pure function near the existing `BATCH_SIZE` exports in `src/campaign.js` (around line 60, near the other pure helpers):

```js
/**
 * Pure predicate — should the idle bulk-check fire for this profile right now?
 * All seven gates must pass. Exported for tests/idle-bulk-check.test.js.
 *
 * @param {object} ctx
 * @param {string}  ctx.mode                  - campaign mode (only connect_and_introduce triggers idle checks)
 * @param {number}  ctx.campaignStartTime     - epoch ms when campaign began
 * @param {boolean} ctx.profileBrowserOpen    - is this profile's browser currently open? (in-batch trigger handles those)
 * @param {boolean} ctx.profileWeeklyLimited  - is this profile parked permanently?
 * @param {number}  ctx.semaphoreAvailable    - remaining browserSemaphore slots (0 = full)
 * @param {number}  ctx.lastBulkCheckAt       - epoch ms of last bulk-check for this (sheet, profile); 0 if never
 * @param {number}  ctx.now                   - epoch ms (current time — injected for testability)
 * @returns {boolean}
 */
export function shouldFireIdleBulkCheck(ctx) {
  if (ctx.mode !== 'connect_and_introduce') return false;
  if (ctx.now - ctx.campaignStartTime < IDLE_CAMPAIGN_MIN_DURATION_MS) return false;
  if (ctx.profileBrowserOpen) return false;
  if (ctx.profileWeeklyLimited) return false;
  if (ctx.semaphoreAvailable <= 0) return false;
  if (ctx.now - ctx.lastBulkCheckAt < IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS) return false;
  return true;
}
```

- [ ] **Step 4: Run the tests — should pass**

```bash
node --test tests/idle-bulk-check.test.js
```

Expected: 8 tests pass.

- [ ] **Step 5: Add the `runIdleBulkCheck` side-effecting helper**

In `src/campaign.js`, add this function inside `startCampaign` after the existing `closeSession` function (around line 1486) so it has access to the closure-scoped `log`, `sessions`, `weeklyLimited`, `browserSemaphore`, `sheetUrl`, `linkedinColumn`, `templates`, `token`, etc.:

```js
/**
 * Idle bulk-check — briefly reopens a parked profile, fires bulkCheck +
 * runAutoIntros, closes. Respects browserSemaphore. Failures non-fatal.
 *
 * Called from the worker-pool loop when shouldFireIdleBulkCheck returns
 * true for a profile.
 */
async function runIdleBulkCheck(profileId, pName) {
  await browserSemaphore.acquire();
  let launched;
  try {
    log(`  📡 [${pName}] Idle bulk-check — briefly reopening profile…`);
    launched = await launchProfile(profileId, token);

    const willAutoIntro = !!(templates?.primaryName && templates?.primaryIntroBody);
    const r = await bulkCheckConnections(launched.page, sheetUrl, linkedinColumn, pName, {
      suppressAcceptedStamp: willAutoIntro,
    });
    if (r.error) {
      log(`  ⚠ [${pName}] Idle bulk-check: ${r.error}`);
    } else {
      const stamped = r.stamped || 0;
      log(`  📡 [${pName}] Idle bulk-check: ${r.matched} Connected, ${stamped} Still Pending (of ${r.fetched})`);
    }

    if (willAutoIntro && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
      await runAutoIntros({
        page: launched.page,
        profileId,
        profileName: pName,
        sheetUrl,
        linkedinColumn,
        connectedUrls: r.connectedUrls,
        primaryName: templates.primaryName.trim(),
        primaryIntroBody: templates.primaryIntroBody.trim(),
        primaryUrl: (templates.primaryUrl || '').trim(),
        introTitle: templates.introTitle || 'Introduction: {first name} <> {intro name}',
        log,
      });
    }

    // Update cooldown
    const _sheetId = _extractSheetIdFromUrl(sheetUrl);
    const cooldown = await readBulkCheckCooldown();
    cooldown[bulkCheckKey(_sheetId, profileId)] = Date.now();
    await writeBulkCheckCooldown(cooldown);
  } catch (err) {
    log(`  ⚠ [${pName}] Idle bulk-check failed: ${err.message}`);
  } finally {
    try {
      if (profileId === 'local-browser') await closeLocalBrowser();
      else await closeProfile(profileId);
    } catch { /* */ }
    browserSemaphore.release();
  }
}
```

- [ ] **Step 6: Run the full suite — confirm nothing broke**

```bash
node --test tests/*.test.js
```

Expected: all tests pass. `runIdleBulkCheck` itself isn't tested in isolation (it's integration-level), but `shouldFireIdleBulkCheck` covers the gate logic.

- [ ] **Step 7: Commit**

```bash
git add tests/idle-bulk-check.test.js src/campaign.js
git commit -m "$(cat <<'EOF'
campaign: add shouldFireIdleBulkCheck predicate + runIdleBulkCheck helper

Predicate is the seven-gate "should idle bulk-check fire?" check
(mode, uptime, browser-state, parked-flag, semaphore slot, cooldown).
Pure function, fully unit-tested.

runIdleBulkCheck is the side-effecting helper — acquires a semaphore
slot, briefly reopens the profile, fires bulk-check + auto-intros if
applicable, writes cooldown timestamp, closes profile, releases slot.
Not yet wired into the worker-pool loop (next task).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire idle bulk-check into the worker-pool loop

**Files:**
- Modify: `src/campaign.js` (worker-pool loop, around line 1540)

- [ ] **Step 1: Find the worker-pool loop**

In `src/campaign.js`, locate the comment `// 2.9.9 — Rotating-batch worker pool` (around line 1540). The loop iterates batch dispatch slots. Look for the per-iteration logic that selects the next profile to send.

- [ ] **Step 2: Add the idle bulk-check pass at the top of each pool iteration**

Insert this block at the START of each worker-pool iteration — BEFORE the slot-selection logic (so idle checks happen before new batches dispatch). Adapt the exact insertion point to fit existing code structure:

```js
// v2.14: connect_and_introduce idle bulk-check pass. Each pool iteration,
// for every profileId that's parked between batches, check if its 5-min
// cooldown has elapsed and a semaphore slot is free — if so, briefly
// reopen the profile to fire a bulk-check + auto-intros, then close.
// All seven gates live in shouldFireIdleBulkCheck (pure, unit-tested).
if (mode === 'connect_and_introduce') {
  const cooldown = await readBulkCheckCooldown().catch(() => ({}));
  const _sheetId = _extractSheetIdFromUrl(sheetUrl);
  for (const profileId of profileIds) {
    const pName = profileNamesById.get(profileId) || profileId;
    const lastBulkCheckAt = cooldown[bulkCheckKey(_sheetId, profileId)] || 0;
    const fire = shouldFireIdleBulkCheck({
      mode,
      campaignStartTime,
      profileBrowserOpen: sessions.has(profileId),
      profileWeeklyLimited: weeklyLimited.has(profileId),
      semaphoreAvailable: browserSemaphore.available?.() ?? 1,
      lastBulkCheckAt,
      now: Date.now(),
    });
    if (!fire) continue;
    // Fire-and-await — keeps the pool iteration's order predictable.
    // The helper acquires its own semaphore slot internally.
    await runIdleBulkCheck(profileId, pName);
  }
}
```

The exact name of `profileNamesById` may vary — check existing code for how profile→display-name mapping is done in this scope. If no map exists, use the existing `pName` derivation pattern (probably from a `_profileName(profileId)` helper or inline construction).

If `browserSemaphore.available()` doesn't exist as a method, check the semaphore module for the right way to query remaining capacity. If only `available` (no parens — property) or no query method exists, add a small `available()` getter to the semaphore module. Don't break other consumers.

- [ ] **Step 3: Manual smoke test**

After saving, run the test suite:

```bash
node --test tests/*.test.js
```

Expected: all tests pass.

Then run a manual smoke test in dev:app — see Step 4.

- [ ] **Step 4: Auto-relaunch dev:app + verify idle checks fire**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

In the Electron shell:
1. Select Connect + Introduce Back mode
2. Set up a test campaign on a fresh sheet (5-10 leads, 2 GoLogin profiles)
3. Open DevTools console (Cmd+Option+I)
4. Start the campaign

Watch the console for:
- `📡 [name] In-batch bulk Connection Status check (5-min cooldown elapsed)` — fires within the active batch after 5 min
- `📡 [name] Idle bulk-check — briefly reopening profile…` — fires for parked profiles when their cooldown elapses AND campaign uptime > 30 min

Since the 30-min uptime gate suppresses idle checks early in the run, the in-batch trigger should fire first (within minutes of campaign start), and the idle trigger should start firing after 30 minutes of uptime.

For a faster smoke test, temporarily lower `IDLE_CAMPAIGN_MIN_DURATION_MS` to `60 * 1000` (1 min) in the source, run the test, then restore to 30 min. Don't commit the temp lowering.

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js
git commit -m "$(cat <<'EOF'
campaign: wire idle bulk-check into the rotating-batch worker pool

Every worker-pool iteration, walks all profiles and fires runIdleBulkCheck
for each parked profile whose seven shouldFireIdleBulkCheck gates pass.
Uses await so iteration order stays predictable; semaphore slot is acquired
inside the helper so the pool doesn't exceed MAX_CONCURRENT_PROFILES.

Effect: in long-running connect_and_introduce campaigns (>30 min), idle
accounts use their wait between batches to fetch their own recent
connections, fire intro DMs for newly-accepted leads, then close again —
no more waiting on the post-campaign scheduler for mid-campaign acceptances.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Verify post-campaign-bulk-check registration call site

**Files:**
- Read-only: `src/campaign.js` (finally block, around lines 2480-2530)
- Read-only: `src/post-campaign-bulk-check.js`

This task is verification only. If the existing code is correct, no commit.

- [ ] **Step 1: Read the registerSchedule call site**

Open `src/campaign.js` and grep for `registerPostCampaignSweep` or `registerSchedule`:

```bash
grep -n "registerPostCampaignSweep\|registerSchedule" src/campaign.js
```

Read the surrounding context (the `try/finally` block at campaign end, somewhere around lines 2480-2530).

- [ ] **Step 2: Verify per-profile registration**

Confirm the code registers ONE schedule entry per profile that actually sent at least one invite during the campaign — NOT just one entry per campaign. The call should be inside a loop over `profileIds` (or a filtered subset of profiles that sent connections).

Expected pattern:
```js
for (const profileId of profilesThatSent) {
  await registerPostCampaignSweep({
    sheetId,
    sheetUrl,
    profileId,
    profileName: ...,
    linkedinColumn,
    days: acceptanceTrackingDays,
    operatorEmail: createdBy,
    mode,
    primaryName: templates.primaryName,
    primaryIntroBody: templates.primaryIntroBody,
    primaryUrl: templates.primaryUrl,
    introTitle: templates.introTitle,
  });
}
```

- [ ] **Step 3: If correct, document the verification**

If everything checks out, add a brief comment marker at the call site so future readers know it's been verified for the multi-account scenario:

```js
// v2.14 verified: per-profile registration ensures every participating
// account's post-campaign 6h × 7d sweep fires independently.
```

Commit only this comment:

```bash
git add src/campaign.js
git commit -m "$(cat <<'EOF'
campaign: verify per-profile post-campaign registration (doc only)

Verified the registerPostCampaignSweep call site registers one entry
per participating profile, with primary fields persisted for the
6h × 7d post-sending sweep to fire auto-intros. No code change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: If broken, fix it**

If the code only registers ONE entry per campaign (not per profile), wrap the existing call in a loop over the participating profile set. Use the same args shape that `registerSchedule` already expects (see `src/post-campaign-bulk-check.js:58-89` for the function signature).

Then commit with a real bug-fix message.

---

## Task 8: Extend test coverage for `connect_and_introduce` action stamps

**Files:**
- Modify: `tests/build-sheet-data-for-action.test.js`

- [ ] **Step 1: Add new tests for `connect_and_introduce` mode**

Open `tests/build-sheet-data-for-action.test.js`. After the existing `already_connected` tests (around line 30), add:

```js
// ── connect_and_introduce: connection_sent ──
test('connect_and_introduce: connection_sent writes Connection Request Status', () => {
  const r = buildSheetDataForAction({
    action: 'connection_sent',
    mode: 'connect_and_introduce',
    profileName: 'matt@ortus'
  });
  // Phase 1 of connect_and_introduce is identical to connect_only for the
  // connection_sent stamp: writes Connection Request Status, mirrors Status,
  // marks Stage as Connect Pending.
  assert.equal(r.connectionStatus, 'Connection Request Sent');
  assert.equal(r.status, 'Connection Request Sent');
  assert.equal(r.stage, 'Connect Pending');
  assert.equal(r.sender, 'matt@ortus');
});

test('connect_and_introduce: already_connected stamp', () => {
  const r = buildSheetDataForAction({
    action: 'already_connected',
    mode: 'connect_and_introduce',
    profileName: 'matt@ortus'
  });
  // Already-1st-degree leads in connect_and_introduce still get the
  // Connection Status (request) stamp + Connected flip — auto-intro
  // happens later via the bulk-check trigger, not via this code path.
  assert.equal(r.connectionStatus, 'Already Connected');
  assert.equal(r.cc, 'Connected');
  assert.equal(r.connectedAlready, 'Yes');
  assert.equal(r.stage, 'Connected');
});
```

- [ ] **Step 2: Run the tests — should pass**

```bash
node --test tests/build-sheet-data-for-action.test.js
```

Expected: all existing tests + 2 new tests pass. If the new tests fail with unexpected field values, the existing `buildSheetDataForAction` in `src/campaign.js` may need a small mode-switch added — but per the spec and the existing campaign.js code at lines 906-911, `connect_and_introduce` already routes through the same `case 'connect_only':` branch for its connectionStatus mapping, so this should pass without code changes.

- [ ] **Step 3: Commit**

```bash
git add tests/build-sheet-data-for-action.test.js
git commit -m "$(cat <<'EOF'
tests: cover connect_and_introduce action stamps in build-sheet-data

Verifies connection_sent + already_connected actions produce the right
Connection Request Status / cc / connectedAlready / Stage fields for the
connect_and_introduce mode. Field names unchanged from connect_only —
the header rename happens in the Apps Script's FIELD_MAP, not in the
bot's field names.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final UAT — full end-to-end smoke test

**Files:** none (manual verification only)

- [ ] **Step 1: Confirm Apps Script redeploys are complete**

Before running this UAT, verify with Antonio that all operators (Antonio, Sam, Katrina) have redeployed the updated `.gs` from their personal Google accounts. The test sheet for this UAT must have a v2 schema already applied (run `prepareSheet` once before the UAT campaign).

- [ ] **Step 2: Run end-to-end UAT**

In the Electron shell with the latest `dev:app`:

1. Open a test Google Sheet with ~10 leads (real LinkedIn URLs the test accounts haven't invited yet).
2. Select **Connect + Introduce Back** mode.
3. Confirm "4. Throughput" shows the **Connections per account per day** knob with the +/− ticker and "invites / account" suffix. Confirm "+ Advanced" is collapsed by default.
4. Configure 2 GoLogin profiles + a primary person (real LinkedIn URL, intro body template).
5. Start the campaign.

Watch for:
- Sheet renders the three-column v2 layout (`Connection Request Status`, `Connection Accepted Status`, `Introduction Status` visible; `Last Action`/`URN`/`Membership ID`/`Connected` hidden; any legacy columns from prior runs hidden).
- Console shows `📡 In-batch bulk Connection Status check` messages firing within the active batches, gated by 5-min cooldown.
- For any lead that accepts mid-campaign: the row's `Introduction Status` flips to `Introduction Made` AND `Connection Accepted Status` stays blank (the dual-stamp avoidance rule).
- For any lead whose acceptance is detected without auto-intro firing (e.g. primary missing — edge case to force by deliberately blanking the primary): `Connection Accepted Status` reads `Connected`.

- [ ] **Step 3: If issues found, fix and re-test**

Any failures here mean the integration of the pieces has a gap. Diagnose, fix, commit per the same pattern (test → fail → fix → pass → commit → auto-relaunch).

- [ ] **Step 4: Close out the feature branch**

If UAT passes cleanly:
1. Confirm the branch is on the expected feature branch name (`git branch --show-current`).
2. Squash-merge or fast-forward-merge to `main` per the project's standard flow.
3. Tag if appropriate (e.g. `v2.14.0`).

Don't push to main without Antonio's explicit go.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Operator runs new JS-side code against an un-redeployed Apps Script | Task 1 Step 9 enforces operator-coordination pause. New JS writes silently no-op on old Apps Scripts (writeFields skips unknown columns) — no data loss, just no acceptance detection until redeploy. |
| Idle bulk-check exceeds `MAX_CONCURRENT_PROFILES` semaphore cap | `runIdleBulkCheck` acquires its own slot via `browserSemaphore.acquire()` before launching. `shouldFireIdleBulkCheck` also checks `semaphoreAvailable > 0` as a pre-gate. |
| Reopen browser overhead (5-20s) extends total campaign duration | Bounded — ~6-10 idle checks per profile per hour campaign × ~15s = ~2 min total overhead. Trivial vs. the value of mid-campaign intros. |
| Renamed column lookup fails on un-migrated sheets (e.g. operator runs the bot before `prepareSheet` migrates) | `computeBulkCheckUpdates` row-lookup chain (Task 3 Step 3) reads BOTH old (`Connected Status`, `CC`, `Check Status`) and new (`Connection Accepted Status`) header names. Survives the rename window. |
| Idle bulk-check fires during the very last batch of a profile's quota, then the post-campaign scheduler also fires immediately | Cooldown timestamp written in both code paths uses the same `bulkCheckKey(sheetId, profileId)` → post-campaign scheduler sees recent timestamp and waits the full 6h before its first sweep. No double-firing. |

---

## Self-Review Notes (run after writing plan)

**Spec coverage:** All 14 locked decisions in the spec map to tasks:
- Decisions 1, 2, 3, 4 → Tasks 4, 5, 6 (in-campaign idle bulk-check)
- Decision 5 → Task 7 (post-sending verification)
- Decision 6 → Tasks 3, 4, 5 (suppressAcceptedStamp wiring)
- Decisions 7, 8, 9, 10, 11 → Task 1 (Apps Script)
- Decision 12 → Task 2 (Throughput knob)
- Decision 13 → Implicit in all log() call sites (no UI changes anywhere)
- Decision 14 → Task 5 (willAutoIntro gate)

**Placeholder scan:** No "TBD" / "TODO" / "implement later". One soft spot is Task 6 Step 2 — the exact name of `profileNamesById` is unknown without re-reading. Plan notes this explicitly so the executor handles it during implementation.

**Type consistency:** `shouldFireIdleBulkCheck` ctx fields (`profileBrowserOpen`, `semaphoreAvailable`, `lastBulkCheckAt`, etc.) appear in the test (Task 5 Step 1), the implementation (Task 5 Step 3), and the call site (Task 6 Step 2). All match.
