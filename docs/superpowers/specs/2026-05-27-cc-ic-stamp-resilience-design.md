# CC+IC Stamp Resilience — Design Spec

**Date:** 2026-05-27
**Branch base:** `drafts-isolation-v2.60.1`
**Scope:** Three independent fixes to make CC+IC runs resilient against (a) a fatal crash at the monitoring-transition step and (b) a false-positive Connected stamp that produces a runaway intro-retry loop.

---

## Background — Sam's 2026-05-27 run

Sam launched a Connect+Introduce campaign with 6 operator profiles. The run produced ~150 intro-send failures over 3 hours, all on the **same 5 lead URNs**, repeated across every operator account. The campaign then crashed at end-of-batch with `Fatal: Cannot set property status of #<Object> which has only a getter`. Pressing Restore reproduced the crash.

Four parallel investigations (`docs/superpowers/specs/.../investigation` was the conversation context, not a written doc) established the following with evidence:

1. **The fatal crash** — `campaign.js:486` defines `status` as an enumerable getter-only property. `transitionToMonitoring` (`campaign-state-transitions.js:24`) returns `{ ...campaign, ... }`, which evaluates the getter and copies its value as a regular data field onto a new object. The caller at `campaign.js:2990` then runs `Object.assign(campaign, updated)`, which tries to assign that data value back onto `campaign.status` — the original getter has no setter, so strict-mode throws.
2. **The bulk-check stamped Connected on the 5 rows** — confirmed exclusively, because only `bulk-check-connections.js:181-186` (the `wasInvited && isMatch` branch) produces the observed multi-column signature: `Stage=Connect Pending` + `CRS=Connection Request Sent` + `CC=Connected` + `Sender=marlon.j`, without overwriting Stage or CRS.
3. **The match was NOT a name-collision false positive** — operator searched Marlon's full 113-connection list (UI) for each of the 5 leads' first or last names; zero results in all 5 cases. The matcher must have hit on slug or encrypted URN at the moment of stamping; the corresponding Voyager records subsequently fell out of the response (LinkedIn-side transient — possibly ghost-acceptance, accept-then-disconnect, or anti-bot honeypot; root cause is outside our code).
4. **The retry storm is by-design** — `bulk-check-connections.js:151-167` only short-circuits rows whose `Introduction Status` is exactly `Introduction Made` or `Introduction Already Made`. Any other value (`Failed —…`, `Skipped —…`) re-queues the row on every subsequent 5-min bulk-check pass. There is no retry cap, no backoff, no feedback from the intro-send result back to the connection-state stamp.
5. **The compose-textbox failure mechanism** — `actions.js:1429-1520` builds `https://www.linkedin.com/messaging/compose/?recipient=<X>` from the lead URL. LinkedIn resolves URN-form `?recipient=` values for real 1st-degree connections but does not load compose for non-connections; `body.boot-complete` never fires, the 30s `waitForFunction` budget expires, and the throw at line 1520 surfaces as `MESSAGE_SEND_FAILED: compose textbox did not appear`. (URN-form is fragile-but-working — verified in the same run where `cayla.pambid` successfully intro'd `linkedin.com/in/ACwAAB3YckMBpZJSFLe6pKOtrIhsYkNyBsbiWP4`.)

## Goal

Three fixes, all in editable files, that together:
- Stop the fatal crash on monitoring transition (every CC+IC run, no operator action needed).
- Detect when bulk-check stamped Connected on a lead the sender cannot actually message, and downgrade the row so it stops being re-queued.
- Cap re-queueing of repeatedly-failing intros even if the detector itself flakes.

**Non-goals:** removing the name-match disjunct in the matcher (no evidence of harm in this incident); investigating the LinkedIn-side cause of the transient Voyager response (outside our codebase); changing `actions.js` or `outreach.js` (off-limits).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Fix A — Crash on monitoring transition                      │
│ Location: src/campaign.js:486                               │
│ Change:   enumerable: true → false on the status getter     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Fix B — Reverify-and-downgrade on compose-textbox failure   │
│ Location: src/linkedin/auto-intro.js                        │
│ Trigger:  errMsg.includes('MESSAGE_SEND_FAILED: compose     │
│           textbox did not appear') AND row CC='Connected'   │
│ Action:   navigate to lead profile, call                    │
│           getConnectionStatus(page) from helpers.js,        │
│           strict-downgrade only on 'connect' or 'pending'   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Fix C — Retry cap on compose-textbox failure                │
│ Location: src/campaign.js (state init) +                    │
│           src/linkedin/auto-intro.js (counter increment) +  │
│           src/linkedin/bulk-check-connections.js (cap check)│
│ State:    campaign.composeAttempts: Map<url, count>         │
│ Cap:      3 — after 3 compose-textbox failures, bulk-check  │
│           stops pushing the URL into connectedUrls          │
└─────────────────────────────────────────────────────────────┘
```

No off-limits files modified. `helpers.js` is read-only-imported. `composeAttempts` follows the existing `introducedInRun` Set pattern.

---

## Components & contracts

### Fix A — `src/campaign.js:485-494`

**Change:** flip `enumerable` on the `status` getter from `true` to `false`.

```js
Object.defineProperty(campaign, 'status', {
  enumerable: false,         // ← was true; this is the only change
  configurable: true,
  get() {
    if (this._paused || this._pauseRequested) return 'paused';
    if (this.running) return 'running';
    if (this.state === 'monitoring') return 'monitoring';
    return 'idle';
  },
});
```

**Verified safe:**
- `getCampaignStatus()` in `campaign.js:3384-...` builds the dashboard payload explicitly. It reads `campaign.state`, `campaign._paused`, `campaign.running` directly — not `campaign.status`. Payload unchanged.
- Registry usages: `campaign-registry.js:48,54,67` all read `entry.status` via direct property access. Direct access invokes the getter regardless of `enumerable`. Behaviour unchanged.
- No callers iterate `campaign` with `for…in`, `Object.keys`, `Object.entries`, or `JSON.stringify` expecting `status` (audited — zero matches in `src/**/*.js` and `server.js`).
- `transitionToMonitoring`'s `{ ...campaign }` spread no longer captures `status` → the subsequent `Object.assign(campaign, updated)` no longer attempts the illegal write → no throw.

### Fix B — `src/linkedin/auto-intro.js`

**New imports** (top of file):
```js
import { getConnectionStatus } from './helpers.js';
```
(`updateSheetRow` and `_formatLocalDate` are already imported.)

**New pure decision helper** (exported for tests, placed near `_friendlyIntroFailure`):
```js
export function _decideReverifyAction(connectionStatus, currentCc) {
  if (currentCc !== 'Connected') {
    return { action: 'noop', reason: 'cc-not-connected' };
  }
  if (connectionStatus === 'connect' || connectionStatus === 'pending') {
    return { action: 'downgrade' };
  }
  if (connectionStatus === 'message') {
    return { action: 'noop', reason: 'genuine-1st-degree' };
  }
  if (connectionStatus === 'follow') {
    return { action: 'noop', reason: 'follow-only-restricted' };
  }
  return { action: 'noop', reason: 'ambiguous' };  // 'unknown' or 'error'
}
```

**New IO helper** (placed next to `_decideReverifyAction`):
```js
async function _reverifyAndDowngrade({
  page, url, profileName, sheetUrl, linkedinColumn, currentCc, log,
}) {
  if (currentCc !== 'Connected') return { reverified: false };
  let connectionStatus;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    connectionStatus = await getConnectionStatus(page);
  } catch (err) {
    log(`  ⚠ [${profileName}] ${url}: reverify navigation failed (${err.message}) — keeping stamp`);
    return { reverified: false, status: 'error' };
  }
  const decision = _decideReverifyAction(connectionStatus, currentCc);
  if (decision.action !== 'downgrade') {
    log(`  ↻ [${profileName}] ${url}: reverify='${connectionStatus}' — keeping stamp (${decision.reason})`);
    return { reverified: true, status: connectionStatus, downgraded: false };
  }
  const now = new Date();
  const stamp = `Unverified — manual review (${_formatLocalDate(now)})`;
  try {
    await updateSheetRow(sheetUrl, url, {
      cc: stamp,
      checkStatus: stamp,
      auditAction: `Reverify after compose failure: not connected (getConnectionStatus='${connectionStatus}')`,
    }, linkedinColumn);
    log(`  ⤓ [${profileName}] ${url}: downgraded — getConnectionStatus='${connectionStatus}'`);
    return { reverified: true, status: connectionStatus, downgraded: true };
  } catch (err) {
    log(`  ⚠ [${profileName}] ${url}: downgrade write failed (${err.message})`);
    return { reverified: true, status: connectionStatus, downgraded: false };
  }
}
```

**Wiring** — inside the existing per-lead failure branch (around `auto-intro.js:327-344`), before the existing `_friendlyIntroFailure` stamp:

```js
// After sendIntroMessage throws and we've captured errMsg:
if (!ok && !alreadyMade && errMsg.includes('MESSAGE_SEND_FAILED: compose textbox did not appear')) {
  const currentCc = (row['Connection Accepted Status'] || row['connection accepted status'] || '').toString().trim();
  await _reverifyAndDowngrade({
    page, url, profileName,
    sheetUrl, linkedinColumn,
    currentCc, log,
  });
}
```

The existing `_friendlyIntroFailure` write at line ~364-376 runs unchanged afterward. If the reverify downgraded the row, the subsequent `Introduction Status = "Failed — …"` write is still made; the CC stamp is the new authoritative signal for the next bulk-check pass.

### Fix B+ — Make the downgrade sticky in bulk-check

`bulk-check-connections.js:99` already short-circuits rows whose CC is exactly `'Connection Declined'` (`if (cs === 'Connection Declined') { dbgAlreadyDeclined++; continue; }`). Without a similar short-circuit for the new `'Unverified — manual review …'` value, the next bulk-check pass — if Voyager still returns the URN — would re-match the row and stamp `cc='Connected'` over the downgrade.

Add immediately after the existing Declined skip at line 99:

```js
if (cs === 'Connection Declined') { dbgAlreadyDeclined++; continue; }
if (cs.startsWith('Unverified — manual review')) {
  dbgAlreadyUnverified++;
  continue;
}
```

Bump the diag block to include `dbgAlreadyUnverified` (line ~245).

Operator-facing semantics: once a row is downgraded, bulk-check ignores it for the rest of the process. To put a downgraded row back into rotation, the operator clears the CC cell manually (and presumably also clears Introduction Status). That's a deliberate gate — false-positive leads should require human judgement, not auto-recovery.

### Fix C — Retry cap

**`src/campaign.js`** — add to the `campaign` object literal near `introducedInRun` (line ~475):
```js
// v2.61.0: count of MESSAGE_SEND_FAILED: compose-textbox failures per URL within
// this process. Bulk-check uses it to stop re-queueing leads that fail repeatedly
// even when the reverify-and-downgrade (auto-intro.js) was inconclusive. Resets
// on each new campaign run.
composeAttempts: new Map(),
```

In `startCampaign` (search for `campaign.introducedInRun = new Set()` — same location):
```js
campaign.composeAttempts = new Map();
```

**`src/linkedin/auto-intro.js`** — inside the same failure branch as Fix B, increment before reverify:
```js
if (errMsg.includes('MESSAGE_SEND_FAILED: compose textbox did not appear')) {
  const prev = campaign.composeAttempts?.get?.(url) || 0;
  campaign.composeAttempts?.set?.(url, prev + 1);
}
```

**`src/linkedin/bulk-check-connections.js`**:

1. Add to the matched-branch skip checks at line ~155-158, after `introducedInRun.has(url)`:
```js
const composeAttempts = opts.composeAttempts;
const attempts = composeAttempts?.get?.(url) || 0;
if (attempts >= 3) {
  dbgComposeCapped++;
  continue;
}
```

2. Add `composeAttempts` to the diag block at line ~245 (so the diag log mentions the cap if it's firing).

3. Pass `composeAttempts: campaign.composeAttempts` from the wrapper `bulkCheckConnections` (line ~341-355) into `computeBulkCheckUpdates`.

`computeBulkCheckUpdates` already accepts an `opts` object; we extend it with `composeAttempts` (default `null` for backwards compat with existing tests).

---

## Data flow

```
Bulk-check pass N (e.g. 19:14:00)
    │
    ├─ Voyager returns marlon's 79 connections (transiently
    │  includes URN_X — LinkedIn-side artefact)
    ├─ Match by encrypted URN → isMatch=true
    └─ Stamp CC='Connected'; URN_X enters connectedUrls
              │
              ▼
runAutoIntros iterates sequentially
    │
    │ sendIntroMessage(page, ..., URN_X) throws
    │   'MESSAGE_SEND_FAILED: compose textbox did not appear'
    │
    │ Catch (NEW):
    │   campaign.composeAttempts.set(URN_X, 1)
    │   row.CC = 'Connected' → trigger _reverifyAndDowngrade:
    │     page.goto(URN_X) → getConnectionStatus(page) → 'connect'
    │     → updateSheetRow(cc='Unverified — manual review ...')
    │
    │ Existing failure stamp runs:
    │   updateSheetRow(introductionStatus='Failed — Compose page didn't load')
              │
              ▼
Bulk-check pass N+1 (5 min later)
    │
    ├─ Voyager response no longer includes URN_X (rolled back)
    ├─ Sheet row: CC='Unverified — manual review …'
    │
    ├─ Matcher line 99 short-circuits: cs.startsWith('Unverified — manual
    │  review') → continue. Row skipped before isMatch is even evaluated.
    │  Same outcome if Voyager DID still return the URN this pass: the
    │  downgrade is sticky.
              │
              ▼
[If reverify itself flaked / returned 'unknown' twice more]
    │
    ├─ campaign.composeAttempts.get(URN_X) >= 3
    ├─ bulk-check skip at new cap-check line → row not in connectedUrls
    └─ Dormant for the rest of the process
```

**Key invariant:** after this change, a CC=Connected row only re-enters `connectedUrls` if (a) the matcher still says yes AND (b) `composeAttempts.get(url) < 3`. Either fix B or fix C removes the row from the rotation.

---

## Error handling

| Error | Handler | Behaviour |
|---|---|---|
| `page.goto` rejects during reverify | catch in `_reverifyAndDowngrade` | Log, return `{reverified:false, status:'error'}`. No downgrade. |
| `getConnectionStatus` returns `'unknown'` | `_decideReverifyAction` | `{action:'noop', reason:'ambiguous'}`. No downgrade. Cap is the safety net. |
| `updateSheetRow` fails during downgrade | catch in `_reverifyAndDowngrade` | Log, return `{downgraded:false}`. Next pass's matcher will re-evaluate; cap eventually stops re-queue. |
| Browser dies mid-reverify | existing `_browserAlive()` checks at `auto-intro.js:214` already bail out before reaching the per-lead body | No reverify attempted; existing `_stampSkipped` path runs. |
| `campaign.composeAttempts` is undefined (e.g. old code path enters before init) | defensive `?.get?.()`/`?.set?.()` chains | Treated as zero attempts. Safe. |
| `enumerable: false` on `status` breaks a hidden caller | audit at design time confirmed no such caller exists; regression test asserts the round-trip works | If a future caller is added that iterates `campaign`, the test catches it. |
| Two reverifies for the same URL race in the same process | impossible — `runAutoIntros` iterates sequentially, one campaign at a time per durable rule | N/A. |

---

## Testing

`node --test`. Three new test files / extensions.

### `tests/campaign-status-getter.test.js` (NEW)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaign } from '../src/campaign.js';

test('status getter remains readable via direct property access', () => {
  campaign.running = false; campaign._paused = false; campaign._pauseRequested = false; campaign.state = undefined;
  assert.strictEqual(campaign.status, 'idle');
  campaign.running = true;
  assert.strictEqual(campaign.status, 'running');
  campaign.running = false; campaign.state = 'monitoring';
  assert.strictEqual(campaign.status, 'monitoring');
});

test('status getter is non-enumerable — spread + Object.assign round-trips cleanly', () => {
  campaign.running = true;
  const snapshot = { ...campaign, state: 'monitoring' };
  assert.ok(!('status' in snapshot) || Object.getOwnPropertyDescriptor(snapshot, 'status') === undefined,
    'spread should not capture status');
  assert.doesNotThrow(() => Object.assign(campaign, snapshot),
    'Object.assign back onto campaign should not throw');
});
```

### `tests/reverify-decision.test.js` (NEW)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _decideReverifyAction } from '../src/linkedin/auto-intro.js';

test('downgrade when getConnectionStatus says connect and CC=Connected', () => {
  assert.deepStrictEqual(_decideReverifyAction('connect', 'Connected'), { action: 'downgrade' });
});
test('downgrade when getConnectionStatus says pending and CC=Connected', () => {
  assert.deepStrictEqual(_decideReverifyAction('pending', 'Connected'), { action: 'downgrade' });
});
test('noop when message (genuine 1st-degree)', () => {
  assert.strictEqual(_decideReverifyAction('message', 'Connected').action, 'noop');
});
test('noop when follow (InMail-restricted)', () => {
  assert.strictEqual(_decideReverifyAction('follow', 'Connected').action, 'noop');
});
test('noop when unknown (ambiguous, cap is safety net)', () => {
  assert.strictEqual(_decideReverifyAction('unknown', 'Connected').action, 'noop');
});
test('noop when CC is not Connected even with connect status', () => {
  assert.strictEqual(_decideReverifyAction('connect', '').action, 'noop');
  assert.strictEqual(_decideReverifyAction('connect', 'Already connected').action, 'noop');
});
```

### `tests/bulk-check-connections.test.js` — EXTEND

Three new tests using the existing test harness:

```js
test('sticky downgrade: cs starts with "Unverified — manual review" → row skipped', () => {
  // row with cc='Unverified — manual review (27/05/2026)' and an otherwise-matching URN
  const { connectedUrls, updates, diag } = computeBulkCheckUpdates(rowsWithUnverifiedCc, conns, '', stillPendingLabel, {});
  assert.ok(!connectedUrls.includes(unverifiedRowUrl));
  assert.strictEqual(diag.alreadyUnverified, 1);
});

test('cap: URL with composeAttempts >= 3 is excluded from connectedUrls', () => {
  const composeAttempts = new Map([[knownMatchedUrl, 3]]);
  const { connectedUrls } = computeBulkCheckUpdates(rows, conns, '', stillPendingLabel, { composeAttempts });
  assert.ok(!connectedUrls.includes(knownMatchedUrl));
});

test('cap: URL with composeAttempts < 3 still flows through to connectedUrls', () => {
  const composeAttempts = new Map([[knownMatchedUrl, 2]]);
  const { connectedUrls } = computeBulkCheckUpdates(rows, conns, '', stillPendingLabel, { composeAttempts });
  assert.ok(connectedUrls.includes(knownMatchedUrl));
});
```

### Manual verification

After all tests green:
1. `pkill -f "npm.*dev:app"; pkill -f "Electron.*ortus"; npm run dev:app > /tmp/dev-app.log 2>&1 &`
2. Confirm app boots cleanly
3. Grep `/tmp/dev-app.log` for `Fatal: Cannot set property status` over a 5-minute window — must be absent

End-to-end CC+IC campaign verification is operator-side (Sam's next live run) and outside the spec's automation surface.

---

## Out of scope (Karpathy #2 — Simplicity First)

- Fix D (removing name-match disjunct from bulk-check matcher) — no evidence it caused this incident; would risk breaking legitimate matches for sheets where name is the only resolvable identifier.
- Persistent retry counter across process restarts — in-memory is sufficient because the downgrade should clear the row first; restart-survival is YAGNI for this incident.
- A dedicated sheet column for retry count — adds Apps Script field-map churn for no operator-facing benefit.
- LinkedIn-side investigation of why Voyager transiently returned the 5 URNs — outside our codebase, not actionable from here.
- Any modification to `actions.js` or `outreach.js` — off-limits per durable operator rule.
- UI changes — "Unverified — manual review" in the sheet's CC column is the operator-visible signal; no dashboard/wizard change required.

---

## Verification gates before merge

- All existing `node --test` tests pass
- 11 new tests (2 status-getter, 6 reverify-decision, 3 bulk-check: 1 sticky-downgrade + 2 cap) pass
- Dev:app boots and produces no `Fatal:` line for 5 minutes idle
- Manual code-review pass against the off-limits rule — no edits to `actions.js` or `outreach.js`
