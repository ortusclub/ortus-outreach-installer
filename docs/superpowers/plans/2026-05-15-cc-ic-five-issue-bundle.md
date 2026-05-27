# CC+IC Five-Issue Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the CC+IC auto-intro DM routing bug + four operator-visibility/UX issues, all in one bundle of atomic commits. Local only — no GitHub push.

**Architecture:**
- The DM-routing bug is fixed by making CC+IC's auto-intro call `sendIntroMessage` with the exact same arguments IB does — drop the 5th `introUrl` argument. CC+IC then uses IB's typeahead-for-primary path which works 100%.
- Reliability is closed by mirroring IB's two safety nets (`withWatchdog` and one retry on transient failure) into `auto-intro.js`.
- Live operator visibility: stamping splits into two Apps Script calls (Connection Accepted at detection, Introduction Status at DM success) with log lines for each.
- UI cleanups: drop the URL-required validation, add Group Conversation Title for CC+IC, rewire the "Bulk Check Connections" button to also fire auto-intros.

**Tech Stack:** Node 22 / Electron 33 / Express 4 / vanilla JS / `node --test`

**Spec:** `docs/superpowers/specs/2026-05-15-monitoring-auto-trigger-design.md` covers the monitoring scheduler (prior phase). This bundle is a follow-on; no separate spec document.

---

### Task 1: Revert `outreach.js:492` — drop `introUrl` 5th arg

**Files:**
- Modify: `src/linkedin/outreach.js:492` (one line)

**Authorization:** Off-limits file. User explicitly authorized this single edit in conversation on 2026-05-15.

- [ ] **Step 1: Verify the current state**

```bash
sed -n '485,495p' src/linkedin/outreach.js
```
Expected: line 492 reads `await sendIntroMessage(page, body, templates.introName, title, templates.introUrl || '');`

- [ ] **Step 2: Make the one-line edit**

Replace:
```js
            await sendIntroMessage(page, body, templates.introName, title, templates.introUrl || '');
```
With:
```js
            await sendIntroMessage(page, body, templates.introName, title);
```

The surrounding comment (lines 488-491) should ALSO be updated to reflect the new reality. Replace:
```js
            // v2.13.14: pass introUrl when set so sendIntroMessage uses
            // URL-routing for the second pill (skips the unreliable
            // typeahead). CC+IC auto-intro populates this; IB leaves it
            // empty so its behaviour is unchanged.
```
With:
```js
            // v2.14.x: CC+IC and IB call sendIntroMessage with the SAME
            // arguments — typeahead-for-primary path. The previous
            // URL-routing experiment (passing templates.introUrl as 5th
            // arg) failed because LinkedIn's compose URL parser is
            // last-wins for repeated ?recipient= params, so the lead's
            // pill was silently dropped. The secondRecipientUrl param on
            // sendIntroMessage now has no caller (dead code, harmless).
```

- [ ] **Step 3: Run tests — no regressions**

```bash
node --test tests/*.test.js
```

- [ ] **Step 4: Commit**

```bash
git add src/linkedin/outreach.js
git commit -m "fix(cc-ic): revert URL-routing for primary, restore IB-parity typeahead path"
```

---

### Task 2: Remove URL-required validation in the launch precheck

**Files:**
- Modify: `public/js/app.js` (around line 2400-2413)

- [ ] **Step 1: Verify the current state**

```bash
sed -n '2395,2415p' public/js/app.js
```
Expected: line ~2405 reads `if (!_pUrl)  missing.push('• Primary Person · LinkedIn URL');`

- [ ] **Step 2: Delete that single validation line**

Remove the `if (!_pUrl) missing.push(...)` line entirely. Keep the line that reads `_pUrl` from the input (line 2400) since `_pUrl` is still used elsewhere in the payload (e.g., line 2477 sends it as `primaryUrl` in the start payload).

Also update the `firstEmpty` fallback at line ~2413 — since URL is no longer required, simplify:
```js
const firstEmpty = !_pName ? 'primary-person-name' : 'primary-intro-body';
```
(drop the `(!_pUrl ? 'primary-person-url' : ...)` middle branch)

- [ ] **Step 3: Manual sanity check**

```bash
node --check public/js/app.js
```

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "feat(cc-ic): make Primary Person LinkedIn URL optional in launch precheck"
```

---

### Task 3: Group Conversation Title field for CC+IC (shared with IB)

**Files:**
- Modify: `public/index.html` (move `intro-title` markup to a shared location OR add a visibility wrapper)
- Modify: `public/js/app.js` (extend `onModeChange` to show the title field in CC+IC mode too)

**Strategy:** The existing `<input id="intro-title">` at `public/index.html:526-527` lives inside an IB-only block. We need it visible in both `introduce_back` and `connect_and_introduce` modes.

The cleanest implementation: wrap the existing `intro-title` row in a `<div id="intro-title-block">` and toggle its visibility in `onModeChange` for both modes. Keep the input ID unchanged (`intro-title`) so all downstream JS that reads `document.getElementById('intro-title').value` continues to work.

- [ ] **Step 1: Inspect the existing intro-title markup**

```bash
sed -n '520,535p' public/index.html
```
Note the surrounding structure (which section it's nested in).

- [ ] **Step 2: Identify the IB section that wraps it**

Find the parent `<div>` that's hidden/shown when mode changes. Look for the `id="tpl-intro-section"` element (or whatever the IB-specific wrapper is). The existing `onModeChange` at `public/js/app.js:1369` already toggles `tpl-intro-section`:
```js
if (intro) intro.style.display = (mode === 'connect_and_introduce') ? '' : 'none';
```
Wait — that line ALREADY shows the intro section for CC+IC. So if `intro-title` is inside `tpl-intro-section`, it's already visible for both modes. Verify this by reading the HTML around the input.

If `intro-title` is NOT inside the shared section: move it there.

If it IS inside the shared section: this task may already be a no-op for the visibility part. Continue to the next step regardless.

- [ ] **Step 3: Ensure `intro-title` value flows into the start payload**

Grep for where `introTitle` is read from the DOM:
```bash
grep -n "intro-title" public/js/app.js | head -10
```

The payload should include `templates.introTitle` (or similar field name the backend expects) set to `document.getElementById('intro-title').value`. Verify both modes' payload-build paths include this — IB already does. For CC+IC, find where `templates.primaryName` / `templates.primaryUrl` etc. are assembled (around line 2477) and verify `introTitle` is alongside them. If not, add:
```js
introTitle: document.getElementById('intro-title')?.value?.trim() || 'Introduction: {first name} <> {intro name}',
```
to the templates object construction for CC+IC.

- [ ] **Step 4: Update CC+IC's wizard help text to mention the title field**

In `public/index.html` near the primary-person-block (around line 264-265), find the footer help text that says `The intro DM body lives in Section 5 · Message Templates below — that's where you'll write it with the variable buttons.` Append a sentence:
```
The Group Conversation Title sits with the intro body in Section 5.
```
(Or wherever the title input visually ends up — adapt the wording to match the actual placement.)

- [ ] **Step 5: Sanity check**

```bash
node --check public/js/app.js
```

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(cc-ic): expose Group Conversation Title field for CC+IC campaigns"
```

---

### Task 4: Rewire "Bulk Check Connections" button → full check + intros

**Files:**
- Modify: `public/js/app.js` (`bulkCheckNow` function around line 6900-7000)
- OR modify: `server.js` `/api/bulk-check-now` route (around line 889) to ALSO fire auto-intros

**Strategy:** The button currently calls `bulkCheckNow()` which fetches `/api/bulk-check-now`. That endpoint runs only the bulk-check. We want it to ALSO run `runAutoIntros` after the bulk-check completes (matching the `/api/monitoring/check-now` behavior the cockpit's flashing-bolt button already has).

Two clean options:
- **Option A** (client-side): Change `bulkCheckNow()` to call `/api/monitoring/check-now` instead of `/api/bulk-check-now`. Simplest, one line. Caveat: `/api/monitoring/check-now` requires `campaign.state === 'monitoring'` (see server.js:697). If the button is shown in non-monitoring contexts, this breaks.
- **Option B** (server-side): Modify the `/api/bulk-check-now` route handler to call `runAutoIntros` after `bulkCheckConnections`. More work but doesn't change contract for other callers.

**Recommended: Option B** since the button label says "Bulk check connections" but the user wants it to do full check + intros — server-side semantics should match.

- [ ] **Step 1: Read the current `/api/bulk-check-now` route**

```bash
sed -n '885,950p' server.js
```
Identify how it currently calls `bulkCheckConnections` and how the page is acquired.

- [ ] **Step 2: After `bulkCheckConnections` succeeds, call `runAutoIntros`**

If the route currently looks like:
```js
const r = await bulkCheckConnections(page, sheetUrl, linkedinColumn, profileName);
res.json({ ok: true, ...r });
```

Wrap the bulk-check + add the intro pass:
```js
const r = await bulkCheckConnections(page, sheetUrl, linkedinColumn, profileName);
if (Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
  const { runAutoIntros } = await import('./src/linkedin/auto-intro.js');
  const campaign = (await import('./src/campaign.js')).campaign;
  await runAutoIntros({
    page,
    profileId: campaign.currentProfile || '',
    profileName,
    sheetUrl,
    linkedinColumn,
    connectedUrls: r.connectedUrls,
    templates: campaign.templates || {},
    senderFirstNames: campaign.senderFirstNames || {},
    log: (line) => console.log(`[bulk-check-now] ${line}`),
  }).catch((err) => console.warn('[bulk-check-now] auto-intro threw:', err.message));
}
res.json({ ok: true, ...r });
```

If the existing route shape differs, adapt — the goal is: after bulk-check returns connectedUrls, fire runAutoIntros with the campaign-stored templates.

- [ ] **Step 3: Sanity check + tests**

```bash
node --check server.js && node --test tests/*.test.js
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(cc-ic): Bulk Check button now runs auto-intros after bulk check"
```

---

### Task 5: Wrap `auto-intro.js`'s `performOutreach` call in `withWatchdog`

**Files:**
- Modify: `src/linkedin/auto-intro.js` (around line 127)

**Strategy:** Mirror IB's hang protection. The IB batch loop at `src/campaign.js:2008` wraps `performOutreach` in `withWatchdog(promise, LEAD_TIMEOUT_MS, profileId)` so a hung typeahead doesn't stall forever. `auto-intro.js` currently has no such wrap.

- [ ] **Step 1: Find `withWatchdog` and `LEAD_TIMEOUT_MS` exports**

```bash
grep -n "withWatchdog\|LEAD_TIMEOUT_MS\|export.*Watchdog" /Users/antoniovarlese/ortus-gologin-clone/src/campaign.js | head -10
```

If they're not exported from `campaign.js`, find where they're defined and export them. Adjust imports accordingly. (`auto-intro.js` already imports from `./campaign.js` at line 24 for `extractLinkedInUrl`.)

- [ ] **Step 2: Add the import**

In `auto-intro.js` near the existing import line (line 24):
```js
import { extractLinkedInUrl, withWatchdog, LEAD_TIMEOUT_MS } from '../campaign.js';
```

If those symbols don't exist in campaign.js's exports, add the `export` keyword to their declarations.

- [ ] **Step 3: Wrap the `performOutreach` call**

In `auto-intro.js:127`, change:
```js
const introResult = await performOutreach(
  page,
  url,
  { ...tpl, data },
  { profileId },
  'force_message',
);
```

To:
```js
let introResult;
try {
  introResult = await withWatchdog(
    performOutreach(page, url, { ...tpl, data }, { profileId }, 'force_message'),
    LEAD_TIMEOUT_MS,
    profileId,
  );
} catch (err) {
  if (err && err.kind === 'watchdog') {
    log(`  ⏱ [${profileName}] Intro DM timed out after ${LEAD_TIMEOUT_MS / 1000}s — ${url}`);
    introResult = { action: 'skipped', error: 'intro_timeout_watchdog' };
  } else {
    throw err;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
node --test tests/*.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/auto-intro.js src/campaign.js
git commit -m "feat(cc-ic): wrap auto-intro performOutreach in withWatchdog (IB parity)"
```

---

### Task 6: One retry on `INTRO_RECIPIENT_NOT_FOUND` in auto-intro

**Files:**
- Modify: `src/linkedin/auto-intro.js`

**Strategy:** When `sendIntroMessage` throws `INTRO_RECIPIENT_NOT_FOUND` (typeahead didn't surface the primary), retry the whole `performOutreach` call ONCE before declaring failure. Light version of IB's 3-retry harness — catches transient flakes without over-engineering.

- [ ] **Step 1: Wrap the call from Task 5 in a retry loop**

After Task 5 lands, the call shape is roughly:
```js
let introResult;
try {
  introResult = await withWatchdog(...)
} catch (err) { ... }
```

Extend this to a 2-attempt loop:
```js
let introResult;
let attempt = 0;
while (attempt < 2) {
  attempt++;
  try {
    introResult = await withWatchdog(
      performOutreach(page, url, { ...tpl, data }, { profileId }, 'force_message'),
      LEAD_TIMEOUT_MS,
      profileId,
    );
    // Check for INTRO_RECIPIENT_NOT_FOUND in the result error (performOutreach
    // catches the throw internally and returns { action: 'skipped', error: '...' }).
    const errStr = String(introResult?.error || '');
    if (attempt < 2 && errStr.includes('INTRO_RECIPIENT_NOT_FOUND')) {
      log(`  ↻ [${profileName}] ${url}: typeahead miss, retrying once…`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    break;
  } catch (err) {
    if (err && err.kind === 'watchdog') {
      log(`  ⏱ [${profileName}] Intro DM timed out after ${LEAD_TIMEOUT_MS / 1000}s — ${url}`);
      introResult = { action: 'skipped', error: 'intro_timeout_watchdog' };
      break;
    }
    throw err;
  }
}
```

- [ ] **Step 2: Run tests**

```bash
node --test tests/*.test.js
```

- [ ] **Step 3: Commit**

```bash
git add src/linkedin/auto-intro.js
git commit -m "feat(cc-ic): retry once on INTRO_RECIPIENT_NOT_FOUND in auto-intro"
```

---

### Task 7: Split stamping — Connection Accepted at detection, Introduction Status at DM success

**Files:**
- Modify: `src/campaign.js` (three call sites passing `suppressAcceptedStamp: willAutoIntro` — lines 1626, 2243, 3247)
- Modify: `src/linkedin/auto-intro.js` (lines 147-151 — remove cc/connectedAlready/checkStatus from success tracking)

**Strategy:** Flip the three `suppressAcceptedStamp: willAutoIntro` call-sites to `suppressAcceptedStamp: false` (or just remove the option). Bulk-check now stamps Connection Accepted IMMEDIATELY upon detection. Then in `auto-intro.js`, the success-tracking only stamps `introductionStatus` — the Connection Accepted columns are already stamped from the bulk-check call. Add a log line for each step.

- [ ] **Step 1: Flip the three bulk-check call sites**

In `src/campaign.js`, at each of lines 1626, 2243, 3247 — change:
```js
suppressAcceptedStamp: willAutoIntro,
```
To:
```js
// v2.14.x: stamp Connection Accepted immediately at bulk-check detection
// so the operator sees acceptance in the sheet BEFORE the intro DM fires.
// The auto-intro pass then only stamps Introduction Status (no longer
// batched into a single write).
suppressAcceptedStamp: false,
```

(Or delete the option entirely since `false` is the default — but the explicit comment helps future-readers.)

- [ ] **Step 2: Strip the cc/connectedAlready/checkStatus from auto-intro success tracking**

In `src/linkedin/auto-intro.js` lines 140-151, change:
```js
const tracking = {
  introductionStatus: ok ? 'Introduction Made' : 'Failed',
  sender: profileName,
  accountUsed: profileName,
  dateLastAction: _formatLocalDate(new Date()),
  auditAction: ok ? `Introduction sent to ${primaryName}` : `Intro failed: ${introResult?.error || 'unknown'}`,
};
if (ok) {
  tracking.cc = 'Connected';
  tracking.connectedAlready = 'Yes';
  tracking.checkStatus = 'Connected';
}
```

To:
```js
// v2.14.x: Connection Accepted Status is now stamped at bulk-check
// detection (suppressAcceptedStamp=false in the campaign call sites).
// auto-intro only stamps Introduction Status here.
const tracking = {
  introductionStatus: ok ? 'Introduction Made' : 'Failed',
  sender: profileName,
  accountUsed: profileName,
  dateLastAction: _formatLocalDate(new Date()),
  auditAction: ok ? `Introduction sent to ${primaryName}` : `Intro failed: ${introResult?.error || 'unknown'}`,
};
```

- [ ] **Step 3: Add log lines for each step**

In `src/linkedin/auto-intro.js`:

Before the `performOutreach` call (around line 126, just before the try block):
```js
log(`  ✓ [${profileName}] ${url}: Connection Accepted (stamped at detection)`);
```

After the successful tracking write (around line 153-155, in the `if (ok)` branch), the existing line already logs `Introduction Made`. Keep it.

So the operator sees:
```
  ✓ [profile] url: Connection Accepted (stamped at detection)
  ... performOutreach runs ...
  🤝 [profile] url: Introduction Made
```

- [ ] **Step 4: Run tests**

```bash
node --test tests/*.test.js
```

If any test asserts on the auto-intro tracking having `cc`/`connectedAlready`/`checkStatus` fields, update it to match the new shape — or note it as a deviation in the report.

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js src/linkedin/auto-intro.js
git commit -m "feat(cc-ic): split stamping — Connection Accepted at detection, Introduction Status at DM success"
```

---

### Final Verification

After all 7 tasks:

- [ ] **Run full test suite**
  ```bash
  node --test tests/*.test.js
  ```

- [ ] **Auto-relaunch dev:app per operator rule**
  ```bash
  pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
  npm run dev:app > /tmp/dev-app.log 2>&1 &
  ```

- [ ] **Manual end-to-end test (user-driven, not agent)**
  1. Reload dashboard
  2. Launch wizard → CC+IC mode
  3. Verify URL field is NOT required (try leaving it blank — wizard should let you start)
  4. Verify Group Conversation Title field is visible
  5. Verify Auto-check cadence dropdown is visible (from prior phase)
  6. Launch a 1-2 lead campaign with cadence=15min
  7. Have the lead accept the connection
  8. Observe in the log:
     - `✓ [profile] url: Connection Accepted (stamped at detection)`
     - `🤝 [profile] url: Introduction Made`
  9. Verify the DM lands on the LEAD (not the primary), with both pills present, group title applied
  10. Verify the sheet shows Connection Accepted Status BEFORE Introduction Status

No GitHub push — user will bundle with other unrelated fixes later.
