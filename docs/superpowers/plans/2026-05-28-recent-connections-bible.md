# Recent Connections Tab as Matching Bible — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-campaign "Recent Connections" sheet tab the authoritative, accumulating, sender-scoped record of who is connected to whom — and match against it — so acceptances stop being lost when they fall off LinkedIn's 80-connection window.

**Architecture:** The Apps Script (Sheet side) owns accumulation: it appends only new, deduped connections per account on each sweep, drops non-campaign accounts, and returns the full accumulated scoped set in one round-trip. The Node matcher (`computeBulkCheckUpdates`) gains per-entry account attribution so "is this lead connected?" is answered from the accumulated tab (any campaign sender), while "should I downgrade to Still Pending?" stays scoped to the sweeping account. The tab is wiped clean at campaign start (not on resume).

**Tech Stack:** Node ≥22, `node --test`, Express, vanilla JS. Google Apps Script (GAS) for the Sheet bridge (`google-apps-script.js`, pasted into each operator's Apps Script editor — no test harness, verified manually).

---

## Spec coverage

Implements `docs/superpowers/specs/2026-05-28-recent-connections-bible-design.md`. Findings A & B from `REVIEW-connection-check.md`.

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/linkedin/bulk-check-connections.js` | Match sheet rows against connections; run one sweep | Per-entry `account` attribution in matcher; wire accumulated set + fallback in `bulkCheckConnections` |
| `src/sheets-writer.js` | Node→GAS bridge | `writeRecentConnectionsTab` returns the accumulated set; add `clearRecentConnectionsTab` |
| `google-apps-script.js` | Sheet-side tab storage | Append-dedupe + return accumulated set; new `clearRecentConnections` action + routing |
| `src/campaign.js` | Campaign orchestration | Wipe tab once at start when `!resumeContext` |
| `tests/bulk-check-connections.test.js` | Matcher unit tests | Add `account` to fixtures; new cross-account-accumulation tests |

**Build order:** Task 1 (matcher + tests, pure) → Task 2 (sheets-writer bridge) → Task 3 (GAS, manual) → Task 4 (wire bulkCheckConnections) → Task 5 (campaign wipe). Each task commits independently; the Task 4 fallback keeps sweeps working even before Task 3's GAS is deployed.

---

### Task 1: Per-entry account attribution in `computeBulkCheckUpdates`

**Files:**
- Modify: `src/linkedin/bulk-check-connections.js:78-87` (match-set building) and `:164-249` (attribution + cross-sender branch) and `:283-300` (pre-existing stamp)
- Test: `tests/bulk-check-connections.test.js`

The matcher currently builds three plain Sets (`connectedSlugs`, `connectedMemberIds`, `connectedNames`) and decides cross-sender purely from `profileName`. We change the Sets to maps of `key → Set<account>` so "which campaign accounts have this lead" comes from the connections themselves. The Still-Pending self-scoping guard and Guard-1 stay exactly as they are (they use `profileName`/`activeSenders`).

- [ ] **Step 1: Write failing tests for account attribution**

Add these tests to the end of `tests/bulk-check-connections.test.js`:

```javascript
// ──────────────────────────────────────────────────────────────────────
// Tab-as-Bible — per-entry account attribution (accumulated tab matching)
// ──────────────────────────────────────────────────────────────────────

// A connection carrying an explicit owning account (as stored in the tab).
const connWithAccount = (account, overrides = {}) => ({
  firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe',
  urn: 'ACoAAaaa', memberNumber: '111', account, ...overrides,
});

test('accumulation: lead owned by the row\'s assigned sender → Connected (even when another account is sweeping)', () => {
  // Carmella swept earlier and recorded Jane under her account. Eryca sweeps
  // now; the accumulated tab still carries Jane@carmella. Jane's row is
  // assigned to carmella → must read Connected, NOT cross-sender.
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const accumulated = [connWithAccount('carmella.s@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(jane, 'jane gets stamped');
  assert.equal(jane.cc, 'Connected', 'assigned-sender ownership → Connected');
  assert.ok(connectedUrls.includes('https://linkedin.com/in/jane-doe'));
});

test('attribution: lead owned ONLY by a different campaign sender → "Already connected to <that account>"', () => {
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  // Jane is owned by eryca in the tab, but her row is assigned to carmella.
  const accumulated = [connWithAccount('eryca.bilazon@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(jane);
  assert.equal(jane.stage, 'Already connected to eryca.bilazon@ortus.solutions');
  assert.equal(jane.cc, undefined, 'no Connected stamp on another sender\'s row');
  assert.ok(!connectedUrls.includes('https://linkedin.com/in/jane-doe'));
});

test('attribution: lead owned by BOTH assigned sender and another → Connected wins', () => {
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const accumulated = [
    connWithAccount('carmella.s@ortus.solutions'),
    connWithAccount('eryca.bilazon@ortus.solutions'),
  ];
  const { updates } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(jane.cc, 'Connected', 'assigned sender owns it → Connected regardless of others');
});
```

- [ ] **Step 2: Update existing fixtures to carry `account`**

The existing v2.62 tests assume every conn belongs to the sweeping profile. Make that explicit so they pass under attribution. Edit `tests/bulk-check-connections.test.js`:

Change the shared `baseConns` (line ~14) to attribute to the profile those tests pass:

```javascript
const baseConns = [
  { firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'eryca.bilazon@ortus.solutions' },
];
```

In the test `'matched + NOT invited: stamps Sender + Stage = "Already connected"'` (line ~165), the conn account must match the profile so the pre-existing branch attributes correctly. It already passes `profileName: 'kenya5@ortus.solutions'`; update that test's conns inline:

```javascript
  const rows = [baseRow({ 'Connection Request Status': '' })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
```

Apply the same inline-conns change (account = `'kenya5@ortus.solutions'`) to the two SB-2 tests (lines ~76, ~96), the `'matched + wasInvited'` test (line ~148), the `'matched + NOT invited + suppressAcceptedStamp'` test (line ~185), and `'row marked "Already connected" + introduction already made'` (line ~196) — each passes `profileName: 'kenya5@ortus.solutions'` (or `'eryca...'` for the v2.62 block) and must use a conn whose `account` equals that profile. For the v2.62 block tests at lines ~299, ~324 the shared `baseConns` (now account=`eryca...`) already matches their `profileName: 'eryca...'`, so no change needed there.

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `node --test tests/bulk-check-connections.test.js`
Expected: the three new attribution tests FAIL (matcher ignores `account`), existing tests still pass.

- [ ] **Step 4: Replace the match-set building block**

In `src/linkedin/bulk-check-connections.js`, replace lines 78-93 (the `connectedSlugs`/`connectedMemberIds`/`connectedNames` build + samples) with account-attributed maps:

```javascript
  // Build account-attributed match indexes. Each connection carries the
  // `account` (campaign Sender) that owns it — supplied by the caller from
  // the accumulated "Recent Connections" tab, or attributed to the sweeping
  // profile on the live-fetch fallback path. Key → Set<accountNorm>.
  const slugToAccounts = new Map();
  const memberIdToAccounts = new Map();
  const nameToAccounts = new Map();
  const accountDisplay = new Map(); // accountNorm → original-case (for stamps)
  const _addAcct = (map, key, acct) => {
    if (!key) return;
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(acct);
  };
  for (const c of conns) {
    const acctRaw = (c.account || '').toString().trim();
    const acct = acctRaw.toLowerCase();
    if (acct && !accountDisplay.has(acct)) accountDisplay.set(acct, acctRaw);
    if (c.publicId) _addAcct(slugToAccounts, c.publicId.toLowerCase(), acct);
    const mid = memberIdFromAny(c.urn) || memberIdFromAny(c.publicId);
    if (mid) _addAcct(memberIdToAccounts, mid, acct);
    const nameKey = `${(c.firstName || '').toLowerCase().trim()} ${(c.lastName || '').toLowerCase().trim()}`.trim();
    if (nameKey && nameKey !== ' ') _addAcct(nameToAccounts, nameKey, acct);
  }

  // Snapshot a few extracted IDs for the diag eyeball-compare.
  const sampleConnectedSlugs = [...slugToAccounts.keys()].slice(0, 3);
  const sampleConnectedMemberIds = [...memberIdToAccounts.keys()].slice(0, 3);
  const sampleConnectedNames = [...nameToAccounts.keys()].slice(0, 3);
```

Also update the three `diag` size fields at the return (lines ~349-351) to use the maps:

```javascript
      slugs: slugToAccounts.size,
      memberIds: memberIdToAccounts.size,
      names: nameToAccounts.size,
```

And in the early Guard-1 return block (lines ~121), update those same three to `slugToAccounts.size`, `memberIdToAccounts.size`, `nameToAccounts.size`.

- [ ] **Step 5: Replace the per-row match + attribution logic**

In `src/linkedin/bulk-check-connections.js`, replace the `isMatch` computation (lines 173-175) with account-aware matching:

```javascript
    // Which campaign accounts have this lead in the accumulated tab?
    const _matchedAccounts = new Set();
    for (const a of (slugToAccounts.get(slug) || [])) _matchedAccounts.add(a);
    if (memberId) for (const a of (memberIdToAccounts.get(memberId) || [])) _matchedAccounts.add(a);
    if (nameKey && nameKey !== ' ') for (const a of (nameToAccounts.get(nameKey) || [])) _matchedAccounts.add(a);
    const isMatch = _matchedAccounts.size > 0;

    // Is the row's ASSIGNED sender among the accounts connected to this lead?
    // Legacy sheets (no Sender column) → any match counts as the assigned one.
    const _assignedConnected = rowSenderNorm
      ? _matchedAccounts.has(rowSenderNorm)
      : isMatch;
```

Note `rowSenderNorm` is already computed at lines 167-168 (keep it). Then replace the cross-sender branch (lines 231-249) so it fires on attribution, not the old `rowSenderMismatch`, and names the connected account from the tab:

```javascript
      // A DIFFERENT campaign sender owns this lead (the assigned sender's
      // invite may still be pending). Informational Stage only — no cc, no
      // connectedUrls, don't overwrite an existing Connected stamp.
      if (!_assignedConnected) {
        dbgCrossSender++;
        if (suppressAcceptedStamp) continue;
        if (cs === 'Connected' || cs.startsWith('Already connected')) continue;
        let _other = '';
        for (const a of _matchedAccounts) { if (a) { _other = accountDisplay.get(a) || a; break; } }
        updates.push({
          linkedinUrl: url,
          stage: `Already connected to ${_other}`,
        });
        continue;
      }
```

In the pre-existing-1st-degree stamp (lines 292-299), stamp the owning account as Sender (prefer the row's own Sender, else the matched account):

```javascript
          updates.push({
            linkedinUrl: url,
            sender: rowSenderRaw || accountDisplay.get([..._matchedAccounts].find((a) => a) || '') || profileName,
            stage: 'Already connected',
            cc: 'Already connected',
            connectedAlready: 'Yes',
            checkStatus: 'Already connected',
          });
```

Leave the Still-Pending self-scoping guard (lines 305-331) and Guard-1 (lines 108-127) untouched — they still use `profileName`/`activeSenders`/`rowSenderMismatch` to avoid downgrading other senders' rows. Delete the now-unused inline `rowSenderMismatch` reference inside the matched branch only if it is no longer read there (the Still-Pending branch at line 311 still needs it — keep that one).

- [ ] **Step 6: Run the full matcher test suite**

Run: `node --test tests/bulk-check-connections.test.js`
Expected: PASS — all existing tests plus the three new attribution tests.

- [ ] **Step 7: Commit**

```bash
git add src/linkedin/bulk-check-connections.js tests/bulk-check-connections.test.js
git commit -m "feat(bulk-check): attribute connections to owning account for tab-based matching"
```

---

### Task 2: `writeRecentConnectionsTab` returns accumulated set + add `clearRecentConnectionsTab`

**Files:**
- Modify: `src/sheets-writer.js:297-318`
- Add: `clearRecentConnectionsTab` export in `src/sheets-writer.js`

- [ ] **Step 1: Return the accumulated set from `writeRecentConnectionsTab`**

Replace the success branch in `writeRecentConnectionsTab` (lines 308-313) so it returns the accumulated rows the GAS response provides (Task 3 adds `accumulated` to the response). Returns `null` on any failure so callers can detect the degrade-to-live-fetch path:

```javascript
    if (result?.ok) {
      console.log(`[sheets-writer] ✓ Wrote ${result.rows} row(s) to "${result.tab}" (accumulated: ${Array.isArray(result.accumulated) ? result.accumulated.length : 0})`);
      return Array.isArray(result.accumulated) ? result.accumulated : [];
    }
    if (result?.error) console.warn(`[sheets-writer] writeRecentConnections failed: ${result.error}`);
    return null;
```

Update the `catch` (line 315) to `return null;` (it already does — confirm).

- [ ] **Step 2: Add the `clearRecentConnectionsTab` wrapper**

Add directly after `writeRecentConnectionsTab` in `src/sheets-writer.js`:

```javascript
/**
 * Wipe the "Recent Connections" tab clean (keeps the header row). Called once
 * at campaign start so the tab is a fresh per-campaign record. Best-effort —
 * returns false on any failure; a stale tab is non-fatal (active-sender
 * scoping still prevents foreign-account false positives).
 */
export async function clearRecentConnectionsTab(sheetUrl) {
  if (!getWebAppUrl()) return false;
  const sheetId = extractSheetId(sheetUrl);
  try {
    const result = await postToWebApp({ action: 'clearRecentConnections', sheetId });
    if (result?.ok) {
      console.log('[sheets-writer] ✓ Cleared "Recent Connections" tab');
      return true;
    }
    if (result?.error) console.warn(`[sheets-writer] clearRecentConnections failed: ${result.error}`);
    return false;
  } catch (err) {
    console.warn(`[sheets-writer] clearRecentConnections threw: ${err.message}`);
    return false;
  }
}
```

- [ ] **Step 3: Verify the module loads (no syntax errors)**

Run: `node --check src/sheets-writer.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add src/sheets-writer.js
git commit -m "feat(sheets-writer): return accumulated set + add clearRecentConnectionsTab"
```

---

### Task 3: Apps Script — append-dedupe, return accumulated set, add clear action

**Files:**
- Modify: `google-apps-script.js:381-406` (doPost routing), `:1399-1478` (`handleWriteRecentConnections`)
- Add: `handleClearRecentConnections` in `google-apps-script.js`

> **Note:** GAS has no test harness in this repo. Verify manually on a scratch sheet (Step 5). Keep the logic simple and pure.

- [ ] **Step 1: Add the clear action to doPost routing**

In the `switch (data.action)` block, add a case after `writeRecentConnections` (line 402):

```javascript
      case 'clearRecentConnections':
        return handleClearRecentConnections(spreadsheet, data);
```

- [ ] **Step 2: Rewrite `handleWriteRecentConnections` to append-dedupe + return accumulated**

Replace the refresh/write body (lines 1434-1477) — keep the header-write block above it unchanged. The new logic: keep all rows EXCEPT non-campaign accounts; dedupe new rows for THIS sender against what's already stored (by URN → Public ID → name, per account); append only genuinely new people; return the full kept+new set.

```javascript
  // Read existing rows once.
  var lastRow = sheet.getLastRow();
  var existing = [];
  if (lastRow >= 2) {
    existing = sheet.getRange(2, 1, lastRow - 1, RECENT_HEADERS.length).getValues();
  }

  // Identity key for dedupe, scoped per account. URN (ACoAA…) wins, then
  // Public ID slug, then first+last name. Mirrors the Node matcher's keys.
  function _identityKey(account, urn, publicId, firstName, lastName) {
    var acct = (account || '').toString().trim().toLowerCase();
    var u = (urn || '').toString().trim().toLowerCase();
    if (u) return acct + '|urn:' + u;
    var p = (publicId || '').toString().trim().toLowerCase();
    if (p) return acct + '|pid:' + p;
    var n = ((firstName || '') + ' ' + (lastName || '')).toString().trim().toLowerCase();
    return acct + '|name:' + n;
  }

  // Keep rows from other campaign accounts (drop non-campaign accounts), and
  // keep THIS sender's existing rows too — we only ADD new people, never wipe.
  var keptRows = [];
  var seenKeys = {};
  for (var r = 0; r < existing.length; r++) {
    var rowSender = (existing[r][0] || '').toString().trim();
    if (hasActiveSenderScope && !activeSendersLower[rowSender.toLowerCase()]) continue;
    keptRows.push(existing[r]);
    // existing columns: [Account, First, Last, PublicId, URN, MemberId, ...]
    seenKeys[_identityKey(rowSender, existing[r][4], existing[r][3], existing[r][1], existing[r][2])] = true;
  }

  var fetchedAt = new Date().toISOString();
  var appended = 0;
  for (var i = 0; i < connections.length; i++) {
    var c = connections[i];
    var acct = sender || (c.profileSentBy || '');
    var key = _identityKey(acct, c.urn, c.publicId, c.firstName, c.lastName);
    if (seenKeys[key]) continue;     // dedupe — already in the tab for this account
    seenKeys[key] = true;
    keptRows.push([
      acct,
      c.firstName || '',
      c.lastName || '',
      c.publicId || '',
      c.urn || '',
      c.memberNumber || '',
      c.connectedAt ? new Date(c.connectedAt).toISOString() : '',
      fetchedAt,
    ]);
    appended++;
  }

  // Rewrite the data area with the combined (kept + newly-appended) set.
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, RECENT_HEADERS.length).clearContent();
  }
  if (keptRows.length > 0) {
    sheet.getRange(2, 1, keptRows.length, RECENT_HEADERS.length).setValues(keptRows);
  }

  // Return the full accumulated set so the bot matches against the tab, not
  // the live 80-fetch. Shape mirrors the Node `conns` objects + `account`.
  var accumulated = keptRows.map(function (row) {
    return {
      account: row[0], firstName: row[1], lastName: row[2],
      publicId: row[3], urn: row[4], memberNumber: row[5],
    };
  });

  return jsonResponse({ ok: true, tab: RECENT_TAB_NAME, rows: appended, accumulated: accumulated });
```

- [ ] **Step 3: Add `handleClearRecentConnections`**

Add after `handleWriteRecentConnections`:

```javascript
// Action: clearRecentConnections — wipe the tab clean at campaign start.
// Keeps the header row; removes all data rows. Idempotent (no-op if absent).
function handleClearRecentConnections(spreadsheet, data) {
  var sheet = spreadsheet.getSheetByName(RECENT_TAB_NAME);
  if (!sheet) {
    return jsonResponse({ ok: true, tab: RECENT_TAB_NAME, cleared: 0 });
  }
  var lastRow = sheet.getLastRow();
  var cleared = 0;
  if (lastRow >= 2) {
    cleared = lastRow - 1;
    sheet.getRange(2, 1, lastRow - 1, RECENT_HEADERS.length).clearContent();
  }
  return jsonResponse({ ok: true, tab: RECENT_TAB_NAME, cleared: cleared });
}
```

- [ ] **Step 4: Syntax-check the GAS file**

Run: `node --check google-apps-script.js`
Expected: no output (exit 0). (GAS globals like `SpreadsheetApp` aren't referenced at parse time, so `--check` validates syntax only.)

- [ ] **Step 5: Manual verification on a scratch sheet**

Paste `google-apps-script.js` into a scratch sheet's Apps Script editor, deploy, point a test `.env` `SHEETS_WEBAPP_URL` at it. Then:
1. POST `clearRecentConnections` → tab emptied (header kept).
2. POST `writeRecentConnections` with sender=A, 2 connections → tab has 2 rows, response `accumulated.length === 2`.
3. POST again sender=A with the SAME 2 + 1 new → tab has 3 rows (no duplicates), `rows: 1` appended.
4. POST sender=B with 1 connection, `activeSenders=[A,B]` → tab has 4 rows; `accumulated` includes both A's and B's.
5. POST sender=A with `activeSenders=[A]` (B no longer a campaign sender) → B's row dropped; A's preserved.
Confirm each by eyeballing the tab.

- [ ] **Step 6: Commit**

```bash
git add google-apps-script.js
git commit -m "feat(apps-script): accumulate+dedupe Recent Connections tab, return set, add clear action"
```

---

### Task 4: Wire `bulkCheckConnections` to match against the accumulated tab

**Files:**
- Modify: `src/linkedin/bulk-check-connections.js:436-475`

The sidecar write already happens at lines 436-451. Capture its return (the accumulated set) and feed it to the matcher; on failure, fall back to the live fetch attributed to the sweeping profile so behavior is never worse than today.

- [ ] **Step 1: Capture the accumulated set from the sidecar write**

Replace the sidecar write block (lines 436-451) so it keeps the accumulated set:

```javascript
  // Mirror the fetched connections into the accumulating sidecar tab and get
  // back the full accumulated, sender-scoped set. That set — not the live
  // 80-fetch — is what we match against (the tab is the Bible). Best-effort:
  // if the round-trip fails, fall back to the live fetch attributed to this
  // sweeping profile so a sweep is never worse than the pre-tab behavior.
  let matchSet = null;
  try {
    const sidecarRows = conns.map((c) => ({
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      publicId: c.publicId || '',
      urn: memberIdFromAny(c.urn) || memberIdFromAny(c.publicId) || '',
      memberNumber: c.memberNumber || '',
      connectedAt: c.connectedAt || 0,
      profileSentBy: pName || '',
    }));
    matchSet = await writeRecentConnectionsTab(sheetUrl, pName, sidecarRows, activeSendersList);
  } catch (err) {
    console.warn(`[bulk-check] sidecar tab write failed: ${err.message}`);
  }
  if (!Array.isArray(matchSet)) {
    // Degrade: match against the live fetch, attributed to the sweeping account.
    console.warn('[bulk-check] accumulated set unavailable — matching against live fetch');
    matchSet = conns.map((c) => ({
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      publicId: c.publicId || '',
      urn: memberIdFromAny(c.urn) || memberIdFromAny(c.publicId) || '',
      memberNumber: c.memberNumber || '',
      account: pName || '',
    }));
  }
```

- [ ] **Step 2: Pass `matchSet` (not `conns`) into the matcher**

Replace the `computeBulkCheckUpdates(rows, conns, …)` call (line 460-461) so it uses `matchSet`:

```javascript
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    rows,
    matchSet,
    linkedinColumn,
    stillPendingLabel,
```

(Leave the `opts` object — `suppressAcceptedStamp`, `profileName`, `introducedInRun`, `composeAttempts` — unchanged.)

- [ ] **Step 3: Run the matcher tests + syntax-check**

Run: `node --test tests/bulk-check-connections.test.js && node --check src/linkedin/bulk-check-connections.js`
Expected: PASS, then no output. (The matcher tests still call `computeBulkCheckUpdates` directly, so they're unaffected; this step confirms no regressions and valid syntax.)

- [ ] **Step 4: Commit**

```bash
git add src/linkedin/bulk-check-connections.js
git commit -m "feat(bulk-check): match against accumulated tab set, fall back to live fetch"
```

---

### Task 5: Wipe the tab at campaign start (not on resume)

**Files:**
- Modify: `src/campaign.js` — import + a call early in `startCampaign`

- [ ] **Step 1: Import `clearRecentConnectionsTab`**

Find the existing import of sheet writers in `src/campaign.js` (the line importing from `./sheets-writer.js`, near the top alongside `batchUpdateSheet`). Add `clearRecentConnectionsTab` to that import list. Confirm the current import first:

Run: `grep -n "from './sheets-writer.js'" src/campaign.js`
Then add `clearRecentConnectionsTab` to the named imports on that line.

- [ ] **Step 2: Call the wipe once at campaign start when not resuming**

In `startCampaign`, locate the resume-context block (around `src/campaign.js:1207-1215`, where `resumeContext` is first read). Immediately after the campaign's `sheetUrl` is known and before the batch loop begins, add:

```javascript
  // Tab-as-Bible: the "Recent Connections" tab is a per-campaign record. Wipe
  // it clean at the start of a NEW campaign so stale rows from a prior run on
  // the same sheet can't produce false matches. On resume, keep the tab — the
  // accumulated record belongs to the campaign we're continuing.
  if (!resumeContext) {
    try {
      await clearRecentConnectionsTab(sheetUrl);
    } catch (err) {
      console.warn(`[campaign] Recent Connections wipe failed (non-fatal): ${err.message}`);
    }
  }
```

Place this after `sheetUrl` is validated/normalized but before the first bulk-check can fire. Verify there is no earlier `return`/guard between this line and the loop that would skip it for a valid campaign.

- [ ] **Step 3: Syntax-check + run the full test suite**

Run: `node --check src/campaign.js && node --test tests/*.test.js`
Expected: no syntax output; all tests PASS.

- [ ] **Step 4: Commit + relaunch dev:app (operator rule 2)**

```bash
git add src/campaign.js
git commit -m "feat(campaign): wipe Recent Connections tab at campaign start (not on resume)"
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

---

## Final verification

- [ ] **Full suite:** `node --test tests/*.test.js` → all PASS.
- [ ] **Manual end-to-end** (scratch sheet, two senders A and B, CC+IC mode):
  1. Start campaign → tab is empty.
  2. After A's first sweep → tab fills with A's connections only; no duplicates on subsequent A sweeps.
  3. After B's sweep → B's connections appended; A's preserved.
  4. A row assigned to A whose lead was recorded by A reads **Connected**, even on a later sweep run by B.
  5. A row assigned to A whose lead is only in the tab under B reads **"Already connected to B"**, no Connected stamp, no DM/intro fired.
  6. A lead accepted >80 connections ago (so it has fallen off the live fetch but was recorded earlier in the campaign) stays **Connected** across sweeps — the original breakage is gone.
  7. Resume an interrupted campaign → tab is NOT wiped.

---

## Self-review notes

- **Spec coverage:** wipe-on-start (Task 5), append-dedupe + scope (Task 3), read-back-for-matching (Tasks 2+4), account attribution / three rules (Task 1), graceful fallback (Task 4), resume keeps tab (Task 5). All covered.
- **Type consistency:** the accumulated-set object shape `{ account, firstName, lastName, publicId, urn, memberNumber }` is produced by GAS (Task 3 Step 2), returned by `writeRecentConnectionsTab` (Task 2), and consumed by `computeBulkCheckUpdates` via `c.account`/`c.publicId`/`c.urn`/`c.firstName`/`c.lastName` (Task 1 Step 4). Consistent.
- **Dedupe key parity:** GAS `_identityKey` (URN → Public ID → name, per account) mirrors the matcher's slug/memberId/name keys so what the tab stores is what the matcher can match.
- **Off-limits respected:** no changes to `src/linkedin/outreach.js` or `actions.js`.
- **Open questions (from spec):** accumulated-set size cap — left unbounded (YAGNI); multi-other "Already connected to" — names the first non-empty account (Task 1 Step 5).
