# CC+IC Note-Aware Group Intro + Dedup — Implementation Plan

> **For agentic workers:** TDD throughout (red → green → full suite). Steps use checkbox syntax.

**Goal:** CC+IC produces a real 3-way group intro when a connection note was sent, by reusing the IB clean-compose path for the note case only, with an empty-group dedupe probe — leaving IB and the no-note path byte-for-byte identical.

**Architecture:** Note-aware fork in `auto-intro.js` (allowed) selects clean-compose vs URL-routing. A gated, off-by-default probe inside `sendIntroViaCleanCompose` (`actions.js`) throws the existing `INTRO_ALREADY_EXISTS` when the group already has messages.

**Tech Stack:** Node ≥22, `node --test`, vanilla ES modules, puppeteer-core.

---

### Task 1: Pure routing + probe-decision helpers (auto-intro.js)

**Files:**
- Modify: `src/linkedin/auto-intro.js`
- Test: `tests/ccic-note-group-intro.test.js` (create)

- [ ] **Step 1: Write failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _decideIntroPath, _groupHasHistory } from '../src/linkedin/auto-intro.js';

test('note + lead name → clean-compose', () => {
  assert.equal(_decideIntroPath({ hasConnectionNote: true, leadFullName: 'Angelo Cruz' }), 'clean-compose');
});
test('note + missing lead name → url-routing fallback', () => {
  assert.equal(_decideIntroPath({ hasConnectionNote: true, leadFullName: '' }), 'url-routing');
});
test('no note → url-routing (unchanged path)', () => {
  assert.equal(_decideIntroPath({ hasConnectionNote: false, leadFullName: 'Angelo Cruz' }), 'url-routing');
});
test('_groupHasHistory: any events → already exists', () => {
  assert.equal(_groupHasHistory(0), false);
  assert.equal(_groupHasHistory(3), true);
});
```

- [ ] **Step 2: Run — expect FAIL** (`_decideIntroPath` / `_groupHasHistory` not exported)

Run: `node --test tests/ccic-note-group-intro.test.js`

- [ ] **Step 3: Add the helpers (exported) near the top of auto-intro.js**

```js
// Note-aware intro routing. Clean-compose (typeahead both pills into a blank
// box → real group) only when a connection note created a prior 1:1 thread AND
// we have the lead's full name to typeahead. Otherwise the existing URL-routing
// path (sendIntroMessage), which is unchanged and carries its own existing-thread
// guard. Pure for unit testing.
export function _decideIntroPath({ hasConnectionNote, leadFullName }) {
  if (hasConnectionNote && (leadFullName || '').trim()) return 'clean-compose';
  return 'url-routing';
}

// Dedupe probe decision: any rendered message event in the group compose means
// a thread for this lead+primary already exists → already introduced.
export function _groupHasHistory(eventCount) {
  return Number(eventCount) > 0;
}
```

- [ ] **Step 4: Run — expect PASS**, then full suite `node --test tests/*.test.js`

- [ ] **Step 5: Commit** `feat(intro): note-aware path + probe decision helpers`

---

### Task 2: Wire the fork into runAutoIntros (auto-intro.js)

**Files:**
- Modify: `src/linkedin/auto-intro.js` (import line 21; the send block ~385-413)

- [ ] **Step 1: Add `sendIntroViaCleanCompose` to the actions import**

```js
import { sendIntroMessage, sendIntroViaCleanCompose } from './actions.js';
```

- [ ] **Step 2: Compute `hasConnectionNote` once before the loop** (after the `tpl` build, ~line 204)

```js
// Campaign-level: did this campaign send a connection note? If so the lead has a
// prior 1:1 thread and URL-routing would collapse into it (see spec 2026-06-10).
const hasConnectionNote = (templates.connectionNote || templates.note || '').toString().trim() !== '';
```

- [ ] **Step 3: In the per-lead send block, branch the call.** Replace the single
  `await sendIntroMessage(page, body, primaryName, title, '', url);` with:

```js
const leadFullName = `${leadFirstName} ${leadLastName}`.trim();
const introPath = _decideIntroPath({ hasConnectionNote, leadFullName });
if (hasConnectionNote && introPath === 'url-routing') {
  log(`  ⚠ [${profileName}] ${url}: note campaign but lead name missing — using URL-routing (add First/Last Name to enable group compose).`);
}
if (introPath === 'clean-compose') {
  // Reuse the IB mechanism; probe ON so an existing group → INTRO_ALREADY_EXISTS.
  await sendIntroViaCleanCompose(page, body, leadFullName, primaryName, title, { dedupeProbe: true });
} else {
  await sendIntroMessage(page, body, primaryName, title, '', url);
}
ok = true;
break;
```

- [ ] **Step 4: Honor clean-compose's not-found in the retry-once branch.** Update the
  retry condition (~line 406):

```js
if (attempt < 2 && (errMsg.includes('INTRO_RECIPIENT_NOT_FOUND') || errMsg.includes('IC_INTRO_RECIPIENT_NOT_FOUND'))) {
```

(The `INTRO_ALREADY_EXISTS` catch above it already maps both paths to `alreadyMade`.)

- [ ] **Step 5: Run full suite** `node --test tests/*.test.js` — expect green (no behavior change for the no-note unit paths).

- [ ] **Step 6: Commit** `feat(intro): route CC+IC note campaigns through clean-compose group path`

---

### Task 3: Gated dedupe probe inside sendIntroViaCleanCompose (actions.js)

**Files:**
- Modify: `src/linkedin/actions.js` (signature ~2263; after both pills + settle ~2497)

- [ ] **Step 1: Add the opts param (default {} → IB unchanged)**

```js
export async function sendIntroViaCleanCompose(page, body, leadFullName, primaryName, groupTitle = '', opts = {}) {
```

- [ ] **Step 2: After both recipients added + the existing 1500ms settle (~line 2497),
  insert the gated probe BEFORE the title/body steps**

```js
  // Gated dedupe probe (CC+IC note-branch only; IB passes no opts so this is skipped).
  // With both pills committed, LinkedIn surfaces an existing lead+primary GROUP
  // thread's history inline. Any message events → the trio already has an intro
  // thread → abort with the SAME signal the URL path uses so runAutoIntros stamps
  // "Introduction Already Made". The connection note (1:1 chat) cannot appear here.
  if (opts && opts.dedupeProbe) {
    await new Promise(r => setTimeout(r, 800));
    const eventCount = await page.evaluate(() => document.querySelectorAll(
      '.msg-s-event-listitem, [class*="msg-s-event"], [class*="msg-event-listitem"], .msg-s-message-list-content li'
    ).length);
    if (eventCount > 0) {
      console.log(`[actions:ic-clean] Existing group thread detected (${eventCount} msg events) — already introduced; aborting.`);
      throw new Error('INTRO_ALREADY_EXISTS');
    }
    console.log('[actions:ic-clean] Group compose empty — proceeding to send.');
  }
```

- [ ] **Step 3: Run full suite** `node --test tests/*.test.js` — expect green (no test imports the browser fn; IB path signature is backward-compatible).

- [ ] **Step 4: Manual-verification note** — leave a one-line log so the operator can
  confirm the branch in `/tmp/dev-app.log` during their test run (already added in Step 2).

- [ ] **Step 5: Commit** `feat(intro): gated empty-group dedupe probe in clean-compose (CC+IC note-branch)`

---

### Task 4: Friendly-failure polish + version bump + relaunch

**Files:**
- Modify: `src/linkedin/auto-intro.js` (`_friendlyIntroFailure`), `package.json`

- [ ] **Step 1: Map IC_ clean-compose errors to friendly labels** (in `_friendlyIntroFailure`, before the generic fallback)

```js
  if (m.includes('IC_INTRO_RECIPIENT_NOT_FOUND')) return 'Failed — Lead or primary not in your connections';
  if (m.includes('IC_INTRO_FAILED')) return "Failed — Group compose didn't load";
```

- [ ] **Step 2: Bump version** `package.json` 2.86.16 → **2.86.17**

- [ ] **Step 3: Full suite green** `node --test tests/*.test.js`

- [ ] **Step 4: Relaunch dev:app** (confirm no campaign running first)

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*[Oo]rtus" 2>/dev/null; pkill -f "node_modules/electron/dist" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 5: Commit** `chore: friendly IC failures + bump 2.86.17`

---

## Self-Review

- **Spec coverage:** routing fork (T1/T2), gated probe (T3), dedup-as-Already-Made via existing handler (T2/T3), IB untouched (T3 default-off), no-note untouched (T2 else-branch). ✓
- **Type consistency:** `_decideIntroPath` returns `'clean-compose'`/`'url-routing'` used identically in T2; `dedupeProbe` opts key consistent T2↔T3; `INTRO_ALREADY_EXISTS` string matches the existing handler. ✓
- **Non-goals honored:** no connect/bulk-check/profile-identity edits; IB 5-arg call still valid. ✓
