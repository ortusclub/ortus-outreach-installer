# SoO Account-Status Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write account status back to the team-wide SoO "LinkedIn Accounts" board — flip a credit cell to "In Use" + stamp the operator email on an account's first send, and set "Needs Login = Y" when an account is detected logged out.

**Architecture:** A new best-effort write module `src/soo-writer.js` (companion to the read-only `src/soo.js`) POSTs a new `setSoO` action to the central Apps Script, which locates the account row by Email and writes cells by header name under a `LockService` lock — with an "only if currently Available" guard for credit flips. Two hook points in the existing `src/campaign.js` loop fire these writes; both are wrapped so a failure never touches outreach.

**Tech Stack:** Node ≥22 ESM, `node --test`, Express, Google Apps Script (ES5), GoLogin/puppeteer (unchanged). Off-limits files `src/linkedin/outreach.js` and `src/linkedin/actions.js` are **not** modified.

**Spec:** `docs/superpowers/specs/2026-06-12-soo-account-status-sync-design.md`

---

## Decisions locked in brainstorming (do not re-litigate)

- **Two behaviors only:** auto-flip on use + logout→Needs Login. **No editor UI. No auto-revert** (team resets the board weekly by hand).
- **Mode→column (final, after "skip OP mode for now"):**
  - `connection_sent` in `connect_only` / `connect_and_introduce` / `connect_and_message` → **CC (Credits)** + **CC User**
  - `inmail_sent` in `inmail_only` → **Inmail Credits** + **Inmail User**
  - **everything else → no write** (including all of `open_profile_only`, even its InMail fallback)
- **Who-value:** the operator login email = `campaign.createdBy`, written into the paired User column.
- **Write guard:** a credit cell is flipped to "In Use" **only if it currently reads exactly "Available"** — enforced **server-side in the Apps Script under a script lock**. Never touches NA / Used / an existing In Use / the `(NN)` counts.
- **Flip timing:** the account's **first credit-consuming send** in the run (per-account dedup).
- **Needs Login:** the existing **definitive** `session_expired` park path only (not the 5-consecutive-fails park). Written to the SoO board on the account's own row. **Never auto-cleared.** The existing v2.84 **lead-sheet** flag is **kept as-is**; the board write is **added** alongside it.
- **Account row match:** Email column == the GoLogin profile name (`pName`), case-insensitive. No match → silent no-op.
- **Kill-switch:** on by default; env `ORTUS_SOO_WRITEBACK` set to `off`/`0`/`false` disables it.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/soo-writer.js` | All SoO write logic: pure mode→target map, kill-switch, payload builders, best-effort POST wrappers. Mirrors `src/soo.js`. | **Create** |
| `google-apps-script.js` | Add `setSoO` action handler (row-by-email, header-name writes, Available-guard, `LockService`) + router case. | Modify |
| `src/campaign.js` | Import the writer; add two run-scoped best-effort wrappers (`flipSoOInUse`, `markSoONeedsLogin`) + a per-run dedup Set; call them at the first-send success branch and the `session_expired` park; fix a misleading comment. | Modify |
| `tests/soo-resolve-target.test.js` | Unit-test the pure mode→target mapping. | **Create** |
| `tests/soo-writer-payload.test.js` | Unit-test payload builders + kill-switch. | **Create** |
| `tests/soo-writer-disabled.test.js` | Unit-test the disabled/blank short-circuits (no network). | **Create** |
| `package.json` | Patch version bump. | Modify |

**Critical ops note (call out at handoff):** the `setSoO` action only works in production after **Antonio redeploys the central Apps Script** (`google-apps-script.js` pasted into the Apps Script editor + new deployment). Until then, every write resolves to a best-effort no-op error and outreach is unaffected. This mirrors the existing "paste + redeploy" requirement in `CLAUDE.md`.

---

### Task 1: Pure mode→target mapping (`src/soo-writer.js`)

**Files:**
- Create: `src/soo-writer.js`
- Test: `tests/soo-resolve-target.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/soo-resolve-target.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSoOTarget } from '../src/soo-writer.js';

test('connection_sent in any connect mode → CC column + CC User', () => {
  for (const mode of ['connect_only', 'connect_and_introduce', 'connect_and_message']) {
    assert.deepEqual(
      resolveSoOTarget(mode, 'connection_sent'),
      { creditHeader: 'CC (Credits)', userHeader: 'CC User' },
      mode,
    );
  }
});

test('inmail_sent in inmail_only → Inmail column + Inmail User', () => {
  assert.deepEqual(
    resolveSoOTarget('inmail_only', 'inmail_sent'),
    { creditHeader: 'Inmail Credits', userHeader: 'Inmail User' },
  );
});

test('open_profile_only writes nothing — even on its InMail fallback', () => {
  assert.equal(resolveSoOTarget('open_profile_only', 'op_message_sent'), null);
  assert.equal(resolveSoOTarget('open_profile_only', 'inmail_sent'), null);
});

test('inmail_sent only counts in inmail_only mode', () => {
  assert.equal(resolveSoOTarget('connect_only', 'inmail_sent'), null);
});

test('non-send / check / dm-to-connection actions → null', () => {
  assert.equal(resolveSoOTarget('connect_only', 'already_connected'), null);
  assert.equal(resolveSoOTarget('connect_only', 'already_processed'), null);
  assert.equal(resolveSoOTarget('connect_only', 'status_pending'), null);
  assert.equal(resolveSoOTarget('introduce_back', 'message_sent'), null);
  assert.equal(resolveSoOTarget('message_only', 'message_sent'), null);
  assert.equal(resolveSoOTarget('check_status', 'status_accepted'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/soo-resolve-target.test.js`
Expected: FAIL — `Cannot find module '../src/soo-writer.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/soo-writer.js`:

```js
/**
 * Writes account status back to the State of Operations (SoO) "LinkedIn
 * Accounts" board. Companion to src/soo.js (which only READS the SoO).
 *
 * Two one-way, best-effort writes (see the 2026-06-12 spec):
 *   - flipAccountInUse():        credit cell Available -> In Use + operator email
 *   - markAccountNeedsLoginSoO(): the account's "Needs Login" cell -> 'Y'
 *
 * Every export is best-effort and NEVER throws to the caller. A failure (kill
 * switch off, no email, network error, 503, no matching row) resolves to a
 * result object — outreach must never depend on it.
 */
import { SHEETS_WEBAPP_URL, SOO_SHEET_ID, SOO_SHEET_GID } from './sheets-webapp-url.js';

const SOO_WRITE_TIMEOUT_MS = 10_000;

// The connection-request modes. A 'connection_sent' in any of these consumes a
// CC (connection) credit. open_profile_only / inmail_only are intentionally not
// here.
const CONNECT_MODES = new Set([
  'connect_only',
  'connect_and_introduce',
  'connect_and_message',
]);

/**
 * Pure mapping. Given the campaign mode and the send result's action, return
 * the SoO credit column to flip + its paired User column, or null for "no
 * write". Keyed on the action (what was actually sent) AND gated by mode so
 * open_profile_only writes nothing — including its InMail fallback (OP deferred).
 * @returns {{creditHeader: string, userHeader: string}|null}
 */
export function resolveSoOTarget(mode, action) {
  if (action === 'connection_sent' && CONNECT_MODES.has(mode)) {
    return { creditHeader: 'CC (Credits)', userHeader: 'CC User' };
  }
  if (action === 'inmail_sent' && mode === 'inmail_only') {
    return { creditHeader: 'Inmail Credits', userHeader: 'Inmail User' };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/soo-resolve-target.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/soo-writer.js tests/soo-resolve-target.test.js
git commit -m "feat(soo-sync): pure mode→credit-column mapping for SoO write-back"
```

---

### Task 2: Kill-switch + payload builders (`src/soo-writer.js`)

**Files:**
- Modify: `src/soo-writer.js`
- Test: `tests/soo-writer-payload.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/soo-writer-payload.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFlipPayload,
  buildNeedsLoginPayload,
  sooWritebackEnabled,
} from '../src/soo-writer.js';
import { SOO_SHEET_ID, SOO_SHEET_GID } from '../src/sheets-webapp-url.js';

test('flip payload: In Use + user cell + guard on the credit header', () => {
  const p = buildFlipPayload({
    email: 'a@ortus.solutions',
    creditHeader: 'CC (Credits)',
    userHeader: 'CC User',
    operatorEmail: 'op@ortusclub.com',
  });
  assert.equal(p.action, 'setSoO');
  assert.equal(p.sheetId, SOO_SHEET_ID);
  assert.equal(p.gid, SOO_SHEET_GID);
  assert.equal(p.email, 'a@ortus.solutions');
  assert.deepEqual(p.fields, { 'CC (Credits)': 'In Use', 'CC User': 'op@ortusclub.com' });
  assert.deepEqual(p.guardAvailableFor, ['CC (Credits)']);
});

test('flip payload omits the user cell when operator email is blank', () => {
  const p = buildFlipPayload({
    email: 'a@x', creditHeader: 'CC (Credits)', userHeader: 'CC User', operatorEmail: '',
  });
  assert.deepEqual(p.fields, { 'CC (Credits)': 'In Use' });
});

test('needs-login payload: Needs Login = Y, no guard', () => {
  const p = buildNeedsLoginPayload({ email: 'a@x' });
  assert.equal(p.action, 'setSoO');
  assert.deepEqual(p.fields, { 'Needs Login': 'Y' });
  assert.deepEqual(p.guardAvailableFor, []);
});

test('kill-switch: off/0/false disable (case-insensitive); anything else enables', () => {
  const orig = process.env.ORTUS_SOO_WRITEBACK;
  try {
    for (const v of ['off', '0', 'false', 'OFF', 'False']) {
      process.env.ORTUS_SOO_WRITEBACK = v;
      assert.equal(sooWritebackEnabled(), false, v);
    }
    for (const v of ['', 'on', '1', 'true', 'yes']) {
      process.env.ORTUS_SOO_WRITEBACK = v;
      assert.equal(sooWritebackEnabled(), true, v);
    }
    delete process.env.ORTUS_SOO_WRITEBACK;
    assert.equal(sooWritebackEnabled(), true);
  } finally {
    if (orig === undefined) delete process.env.ORTUS_SOO_WRITEBACK;
    else process.env.ORTUS_SOO_WRITEBACK = orig;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/soo-writer-payload.test.js`
Expected: FAIL — `buildFlipPayload`/`buildNeedsLoginPayload`/`sooWritebackEnabled` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/soo-writer.js` (after `resolveSoOTarget`):

```js
/** Kill-switch: enabled unless ORTUS_SOO_WRITEBACK is off/0/false. Default on. */
export function sooWritebackEnabled() {
  const v = (process.env.ORTUS_SOO_WRITEBACK || '').toString().trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/** Build the setSoO payload for an "In Use" flip (credit + paired user, guarded). */
export function buildFlipPayload({ email, creditHeader, userHeader, operatorEmail }) {
  const fields = { [creditHeader]: 'In Use' };
  if (operatorEmail) fields[userHeader] = operatorEmail;
  return {
    sheetId: SOO_SHEET_ID,   // satisfies the Apps Script router's required field
    gid: SOO_SHEET_GID,      // router resolves the LinkedIn Accounts tab by gid
    action: 'setSoO',
    email,
    fields,
    guardAvailableFor: [creditHeader],
  };
}

/** Build the setSoO payload for a Needs Login flag (no guard). */
export function buildNeedsLoginPayload({ email }) {
  return {
    sheetId: SOO_SHEET_ID,
    gid: SOO_SHEET_GID,
    action: 'setSoO',
    email,
    fields: { 'Needs Login': 'Y' },
    guardAvailableFor: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/soo-writer-payload.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/soo-writer.js tests/soo-writer-payload.test.js
git commit -m "feat(soo-sync): kill-switch + setSoO payload builders"
```

---

### Task 3: Best-effort POST wrappers (`src/soo-writer.js`)

**Files:**
- Modify: `src/soo-writer.js`
- Test: `tests/soo-writer-disabled.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/soo-writer-disabled.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flipAccountInUse, markAccountNeedsLoginSoO } from '../src/soo-writer.js';

// These tests must NOT hit the network. The kill-switch and blank-email guards
// both short-circuit before any fetch, so they are safe to run offline.

test('flip + needs-login are no-ops when the kill-switch is off (no network)', async () => {
  const orig = process.env.ORTUS_SOO_WRITEBACK;
  process.env.ORTUS_SOO_WRITEBACK = 'off';
  try {
    assert.deepEqual(
      await flipAccountInUse({ email: 'a@x', creditHeader: 'CC (Credits)', userHeader: 'CC User', operatorEmail: 'o@x' }),
      { ok: false, disabled: true },
    );
    assert.deepEqual(
      await markAccountNeedsLoginSoO({ email: 'a@x' }),
      { ok: false, disabled: true },
    );
  } finally {
    if (orig === undefined) delete process.env.ORTUS_SOO_WRITEBACK;
    else process.env.ORTUS_SOO_WRITEBACK = orig;
  }
});

test('flip rejects a blank email before any network call', async () => {
  const orig = process.env.ORTUS_SOO_WRITEBACK;
  delete process.env.ORTUS_SOO_WRITEBACK; // enabled
  try {
    assert.deepEqual(
      await flipAccountInUse({ email: '', creditHeader: 'CC (Credits)', userHeader: 'CC User', operatorEmail: 'o@x' }),
      { ok: false, error: 'no email' },
    );
    assert.deepEqual(await markAccountNeedsLoginSoO({ email: '' }), { ok: false, error: 'no email' });
  } finally {
    if (orig !== undefined) process.env.ORTUS_SOO_WRITEBACK = orig;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/soo-writer-disabled.test.js`
Expected: FAIL — `flipAccountInUse`/`markAccountNeedsLoginSoO` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/soo-writer.js`:

```js
// POST a setSoO payload to the central Apps Script. Mirrors src/soo.js: Apps
// Script answers POST with a 302 that node fetch would downgrade to GET, so we
// stop on the redirect and re-fetch the Location.
async function postSetSoO(payload) {
  const signal = AbortSignal.timeout(SOO_WRITE_TIMEOUT_MS);
  const initial = await fetch(SHEETS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal,
  });
  const response = (initial.status >= 300 && initial.status < 400)
    ? await fetch(initial.headers.get('location'), { signal })
    : initial;
  return response.json();
}

/**
 * Flip an account's credit cell to "In Use" (server-side guarded to Available)
 * and stamp the operator email into the paired User cell. Best-effort.
 * @returns {Promise<object>} { ok, matched, written, skipped } or { ok:false, ... }
 */
export async function flipAccountInUse({ email, creditHeader, userHeader, operatorEmail }) {
  if (!sooWritebackEnabled()) return { ok: false, disabled: true };
  if (!email) return { ok: false, error: 'no email' };
  try {
    const data = await postSetSoO(buildFlipPayload({ email, creditHeader, userHeader, operatorEmail }));
    if (data && data.error) return { ok: false, error: data.error };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Set the account's "Needs Login" SoO cell to 'Y'. Best-effort. Never cleared
 * by the app (manual clear by the LinkedIn team).
 * @returns {Promise<object>} { ok, matched, written } or { ok:false, ... }
 */
export async function markAccountNeedsLoginSoO({ email }) {
  if (!sooWritebackEnabled()) return { ok: false, disabled: true };
  if (!email) return { ok: false, error: 'no email' };
  try {
    const data = await postSetSoO(buildNeedsLoginPayload({ email }));
    if (data && data.error) return { ok: false, error: data.error };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/soo-writer-disabled.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole writer suite + confirm no regressions**

Run: `node --test tests/soo-*.test.js`
Expected: PASS (all SoO tests). Then `node --check src/soo-writer.js` → no output (valid).

- [ ] **Step 6: Commit**

```bash
git add src/soo-writer.js tests/soo-writer-disabled.test.js
git commit -m "feat(soo-sync): best-effort flip/needs-login POST wrappers"
```

---

### Task 4: `setSoO` Apps Script action (`google-apps-script.js`)

**Files:**
- Modify: `google-apps-script.js` (router `switch` at line ~381; add handler near `handleGetSoO` ~line 1380)

> No node unit test — this is Apps Script (ES5, runs in Google's runtime, not imported by node). Verified by `node --check` (syntax) here and by the manual smoke test in Task 6. Decision logic is kept as a small inline check that mirrors the spec exactly.

- [ ] **Step 1: Add the router case**

In the `switch (data.action)` block in `doPost` (after the `case 'getSoO':` line ~399), add:

```js
      case 'setSoO':
        return handleSetSoO(sheet, data);
```

(The router already opened `data.sheetId` and resolved `sheet` by `data.gid`, so `handleSetSoO` receives the LinkedIn Accounts tab directly.)

- [ ] **Step 2: Add the handler**

Immediately after the `handleGetSoO` function (before `function jsonResponse`), add:

```js
// ═══════════════════════════════════════════════════════════════════════════
// Action: Set SoO — write account status back to the SoO "LinkedIn Accounts"
// board. Locates the row by Email (case-insensitive), writes each field by
// header name. Headers in guardAvailableFor are written ONLY if the current
// cell reads exactly "Available" (case-insensitive) — so an auto-flip can never
// clobber a colleague's "In Use", an "NA"/"Used", or a (NN) count. Serialized
// with a script lock so two operators can't race the read-then-write guard.
// ═══════════════════════════════════════════════════════════════════════════
function handleSetSoO(sheet, data) {
  if (!data.email) {
    return jsonResponse({ error: 'email is required', errorCode: 'BAD_REQUEST' });
  }
  if (!data.fields || typeof data.fields !== 'object') {
    return jsonResponse({ error: 'fields object is required', errorCode: 'BAD_REQUEST' });
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return jsonResponse({ error: 'could not acquire lock', errorCode: 'LOCKED' });
  }

  try {
    var headers = getHeaders(sheet);

    function headerIndex(name) {
      var want = (name || '').toString().toLowerCase().trim();
      for (var i = 0; i < headers.length; i++) {
        if ((headers[i] || '').toString().toLowerCase().trim() === want) return i;
      }
      return -1;
    }

    var emailCol = headerIndex('Email');
    if (emailCol === -1) {
      return jsonResponse({ error: 'Email column not found', errorCode: 'MISSING_EMAIL_HEADER' });
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonResponse({ success: true, matched: false });

    var wantEmail = data.email.toString().toLowerCase().trim();
    var emailVals = sheet.getRange(2, emailCol + 1, lastRow - 1, 1).getValues();
    var targetRow = -1;
    for (var r = 0; r < emailVals.length; r++) {
      if ((emailVals[r][0] || '').toString().toLowerCase().trim() === wantEmail) {
        targetRow = r + 2;
        break;
      }
    }
    if (targetRow === -1) return jsonResponse({ success: true, matched: false });

    var guard = {};
    (data.guardAvailableFor || []).forEach(function (h) {
      guard[(h || '').toString().toLowerCase().trim()] = true;
    });

    var written = [];
    var skipped = [];
    Object.keys(data.fields).forEach(function (header) {
      var col = headerIndex(header);
      if (col === -1) { skipped.push(header + ' (no column)'); return; }
      if (guard[(header || '').toString().toLowerCase().trim()]) {
        var cur = (sheet.getRange(targetRow, col + 1).getValue() || '').toString().toLowerCase().trim();
        if (cur !== 'available') { skipped.push(header + ' (not Available: "' + cur + '")'); return; }
      }
      sheet.getRange(targetRow, col + 1).setValue(data.fields[header]);
      written.push(header);
    });

    return jsonResponse({ success: true, matched: true, row: targetRow, written: written, skipped: skipped });
  } catch (err) {
    return jsonResponse({ error: err.message, errorCode: 'WRITE_FAILED' });
  } finally {
    lock.releaseLock();
  }
}
```

- [ ] **Step 3: Verify the file still parses**

Run: `node --check google-apps-script.js`
Expected: no output (exit 0). (Catches any brace/syntax slip — the file is plain JS even though it runs in Apps Script.)

- [ ] **Step 4: Commit**

```bash
git add google-apps-script.js
git commit -m "feat(soo-sync): setSoO Apps Script action (row-by-email, header writes, Available-guard, script lock)"
```

---

### Task 5: Wire the campaign loop (`src/campaign.js`)

**Files:**
- Modify: `src/campaign.js` — import (~line 28 area), run-scoped wrappers (after `setAccountNeedsLogin`, ~line 1631), success-branch call (after line 2929), park-branch call + comment fix (lines 2091-2092)

> No new unit test — the pure pieces are covered in Tasks 1-3; this task is wiring, verified by `node --check`, the full suite staying green, and the Task 6 smoke test.

- [ ] **Step 1: Add the import**

After the existing `import` for `./soo.js` is **not** present; add a new import next to the other `src/*` imports near line 28. Insert after the `log-writer.js` import (line ~30):

```js
import { resolveSoOTarget, flipAccountInUse, markAccountNeedsLoginSoO } from './soo-writer.js';
```

- [ ] **Step 2: Add the run-scoped best-effort wrappers**

Find the end of the `setAccountNeedsLogin` function (the closing `}` at ~line 1630, right before the `// v2 schema: prepareSheet...` comment). Immediately after it, insert:

```js
    // v2.95: SoO board write-back (companion to the lead-sheet Needs Login
    // above). Both wrappers are best-effort, one-way, per-run de-duped, and
    // never throw into the loop. They write to the team SoO "LinkedIn Accounts"
    // board, matched by Email == the account's GoLogin profile name.
    const _sooFlipped = new Set();      // accountNorm already flipped to In Use this run
    const _sooNeedsLogin = new Set();   // accountNorm already flagged Needs Login this run

    async function flipSoOInUse(accountName, action) {
      try {
        const target = resolveSoOTarget(mode, action);
        if (!target) return;
        const acctNorm = (accountName || '').toString().toLowerCase().trim();
        if (!acctNorm || _sooFlipped.has(acctNorm)) return;
        _sooFlipped.add(acctNorm);
        const res = await flipAccountInUse({
          email: accountName,
          creditHeader: target.creditHeader,
          userHeader: target.userHeader,
          operatorEmail: campaign.createdBy || '',
        });
        if (res && res.ok && res.matched && res.written && res.written.length) {
          log(`  ⚑ SoO: ${accountName} → ${target.creditHeader} = In Use (${campaign.createdBy || '—'}).`);
        } else if (res && res.ok && res.matched) {
          log(`  · SoO: ${accountName} ${target.creditHeader} not Available — left as-is.`);
        }
      } catch (err) {
        log(`  ⚠ SoO flip failed for ${accountName}: ${err.message}`);
      }
    }

    async function markSoONeedsLogin(accountName) {
      try {
        const acctNorm = (accountName || '').toString().toLowerCase().trim();
        if (!acctNorm || _sooNeedsLogin.has(acctNorm)) return;
        _sooNeedsLogin.add(acctNorm);
        const res = await markAccountNeedsLoginSoO({ email: accountName });
        if (res && res.ok && res.matched) {
          log(`  ⚑ SoO: ${accountName} → Needs Login = Y.`);
        }
      } catch (err) {
        log(`  ⚠ SoO Needs Login failed for ${accountName}: ${err.message}`);
      }
    }
```

- [ ] **Step 3: Call the flip on the first credit-consuming send**

In the `if (SUCCESS_ACTIONS.has(result.action)) {` block, find `await saveState(state);` (line ~2929). Immediately after it, insert:

```js
            // v2.95: SoO write-back — on the account's first credit-consuming
            // send (connection_sent / inmail_sent per mode), flip its SoO credit
            // cell to In Use + stamp the operator. No-op for every other action.
            await flipSoOInUse(pName, result.action);
```

- [ ] **Step 4: Add the Needs Login board write + fix the misleading comment**

At lines 2091-2092, replace:

```js
          // v2.84: flag every SoO row owned by this account as Needs Login = Y.
          await setAccountNeedsLogin(pName, true);
```

with:

```js
          // v2.84: flag every LEAD row handled by this account (Sender column)
          // as Needs Login = Y in the campaign sheet, so the operator can filter
          // to the stalled leads.
          await setAccountNeedsLogin(pName, true);
          // v2.95: ALSO flag this account on the SoO "LinkedIn Accounts" board
          // (matched by Email == profile name) so the LinkedIn team re-logs it.
          // Never auto-cleared. Best-effort — cannot affect the loop.
          await markSoONeedsLogin(pName);
```

- [ ] **Step 5: Verify syntax + full suite stays green**

Run: `node --check src/campaign.js`
Expected: no output (exit 0).

Run: `node --test tests/*.test.js 2>&1 | tail -5`
Expected: the full suite passes with the same pre-existing count plus the 3 new SoO files' tests; 0 failures (pre-existing skips unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js
git commit -m "feat(soo-sync): wire first-send flip + logout Needs Login into the campaign loop"
```

---

### Task 6: Version bump, relaunch, and manual smoke

**Files:**
- Modify: `package.json` (version)

- [ ] **Step 1: Patch-bump the version**

Bump `package.json` `version` by one patch (e.g. `2.94.4` → `2.95.0` — a feature, so minor is also fine; match the repo's current cadence, patch is acceptable). Edit the `"version"` field only.

- [ ] **Step 2: Commit the bump**

```bash
git add package.json
git commit -m "chore: bump version for SoO account-status write-back"
```

- [ ] **Step 3: Relaunch dev:app (per operator rule)**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Wait ~8s, then confirm a clean boot:

```bash
sleep 8 && grep -iE "Ortus Outreach v|gologin\] Total|error|EADDRINUSE" /tmp/dev-app.log | head
```

Expected: the new version banner + profile count, no fatal errors.

- [ ] **Step 4: Manual smoke (the part only a human/live run can verify)**

Document these checks for Antonio to run (or run with him), because they touch the live shared board:

1. **Redeploy first:** confirm the updated `google-apps-script.js` is pasted into the central Apps Script editor and a **new deployment** is published. Without this, `setSoO` returns an error and writes are silent no-ops.
2. **Flip happens once, on an Available account:** start a tiny `connect_only` (or CC+IC) campaign with one pool account whose **CC (Credits)** cell is currently **Available**. After its first connection request, that account's row should show **CC (Credits) = In Use** and **CC User = your login email**. The campaign log shows `⚑ SoO: <email> → CC (Credits) = In Use (...)`.
3. **Guard holds:** pick an account whose CC is already **In Use** by a colleague (or **NA**). Run it; the cell and the existing CC User must be **unchanged**, and the log shows `· SoO: <email> CC (Credits) not Available — left as-is`.
4. **Kill-switch:** set `ORTUS_SOO_WRITEBACK=off` in the env, relaunch, run a campaign — confirm **no** SoO writes occur and the campaign is otherwise normal.
5. **Needs Login (if reproducible):** when an account is parked with `session_expired`, confirm its SoO-board **Needs Login** cell becomes **Y** (and the lead-sheet flag still appears too). If a live logout isn't reproducible on demand, note it as deferred-to-observation rather than blocking.

- [ ] **Step 5: Final whole-suite check**

Run: `node --test tests/*.test.js 2>&1 | tail -3`
Expected: 0 failures.

---

## Self-Review

**1. Spec coverage:**
- §1/§5 auto-flip on first send → Tasks 1, 3, 5 (resolve target, flip wrapper, success-branch hook). ✓
- §4 mode→column (post "skip OP") → Task 1 mapping + tests. ✓
- §3/§5 Available-only guard, server-side, LockService → Task 4 handler. ✓
- §5 who-value = `campaign.createdBy` into paired User col → Task 2 builder + Task 5 wrapper. ✓
- §6 Needs Login: definitive-only path, board write, no auto-clear, keep lead-sheet flag, fix comment → Task 5 Step 4. ✓
- §7 architecture: `setSoO` via standard router, `src/soo-writer.js`, two hooks → Tasks 3,4,5. ✓
- §8 kill-switch on-by-default + hidden flag → Task 2 + tests. ✓
- §9 best-effort isolation, off-limits files untouched → wrappers try/catch; no edit to outreach.js/actions.js. ✓
- §10 testing: mapping, payload, disabled-gate unit tests + manual smoke → Tasks 1-3 + Task 6. ✓
- §11 open items: (1) OP channel resolved by "skip OP mode" decision; (2) first-send site = `SUCCESS_ACTIONS` branch line 2914/after 2929; (3) `campaign.createdBy` confirmed present + blank-fallback in builder. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; manual-smoke steps are explicit checklists, not "test the above." ✓

**3. Type/name consistency:** `resolveSoOTarget(mode, action)` → `{creditHeader, userHeader}`; `buildFlipPayload`/`buildNeedsLoginPayload` → `{sheetId, gid, action, email, fields, guardAvailableFor}`; `flipAccountInUse({email, creditHeader, userHeader, operatorEmail})` and `markAccountNeedsLoginSoO({email})` used identically in Task 5 wrappers; Apps Script reads `data.email`, `data.fields`, `data.guardAvailableFor`, `data.gid`, `data.sheetId` — all matched by the builders. ✓

**Note for executor:** if `git` line numbers have drifted, anchor edits on the quoted surrounding code (e.g. `await saveState(state);`, `await setAccountNeedsLogin(pName, true);`, the `setAccountNeedsLogin` closing brace) rather than absolute line numbers.
