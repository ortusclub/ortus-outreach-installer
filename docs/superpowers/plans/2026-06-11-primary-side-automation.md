# Primary-Side Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add auto-accept of the primary connection and an automated first follow-up to the CC+IC flow, both driven by one persisted task queue and one safe-window runner that never opens a second browser.

**Architecture:** A pure persistence/selection core (`src/primary-tasks.js`) holds `accept` + `follow-up` tasks. Tasks are enqueued at the existing fire points — follow-ups inside `runAutoIntros` (covers all 4 intro paths), accepts at the connect-to-primary site. A 60s runner (`src/primary-task-runner.js`) drains due tasks one browser at a time, gated on the existing `browser-semaphore.js` count being 0 and `campaign.running` false. Two net-new DOM primitives (`accept-invitation.js`, `thread-message.js`) live in new files; `actions.js`/`outreach.js` are never modified.

**Tech Stack:** Node ≥22 ESM, `node --test`, Express 4, GoLogin SDK + puppeteer-core. Reuses existing `browser-semaphore.js`, `match-primary.js`, `personalizeTemplate` (`helpers.js`), `extractSheetId` (`utils.js`), `appendCampaignLog` (`campaign-log-bus.js`).

**Spec:** `docs/superpowers/specs/2026-06-11-primary-side-automation-design.md`

**Off-limits (never modify):** `src/linkedin/outreach.js`, `src/linkedin/actions.js`. Import their primitives only.

---

## Task 0: Branch + version bump

**Files:**
- Modify: `package.json` (version field)

- [ ] **Step 1: Create the feature branch**

Run:
```bash
cd /Users/antoniovarlese/ortus-gologin-clone
git checkout main && git pull --ff-only 2>/dev/null; git checkout -b primary-side-automation-2.91
```
Expected: `Switched to a new branch 'primary-side-automation-2.91'`

- [ ] **Step 2: Bump the version**

In `package.json`, change `"version": "2.90.1"` to `"version": "2.91.0"`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: branch + bump to 2.91.0 for primary-side automation"
```

---

## Task 1: Task queue core (`src/primary-tasks.js`)

Pure persistence + selection + pure task builders. No Puppeteer, no campaign imports. This is the testable foundation everything else uses. The file path is injectable so tests write to a temp file.

**Files:**
- Create: `src/primary-tasks.js`
- Test: `tests/primary-tasks.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/primary-tasks.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  buildFollowUpTask, buildAcceptTask, dedupeKey, selectDue, partitionByBrowser,
  loadTasks, saveTasks, enqueuePrimaryTask, markTask, resetInProgress,
} from '../src/primary-tasks.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'ptasks-'));
  return join(dir, 'primary-tasks.json');
}

test('buildFollowUpTask sets type, dueAt, pending status', () => {
  const t = buildFollowUpTask({
    campaignProfileId: 'p1', campaignProfileName: 'patrick.s', sheetId: 's1', sheetUrl: 'u',
    sender: 'local-browser', threadUrl: 'https://www.linkedin.com/messaging/thread/abc',
    introTitle: 'Intro', leadName: 'Jane Doe', leadUrl: 'https://lnkd/in/jane',
    primaryName: 'You', primaryUrl: 'https://lnkd/in/you', body: 'Hi Jane',
    delayMinutes: 10, now: 1_000_000,
  });
  assert.equal(t.type, 'follow-up');
  assert.equal(t.status, 'pending');
  assert.equal(t.attempts, 0);
  assert.equal(t.dueAt, 1_000_000 + 10 * 60_000);
  assert.equal(t.sender, 'local-browser');
  assert.equal(t.body, 'Hi Jane');
});

test('buildAcceptTask is due immediately and carries the account identity', () => {
  const t = buildAcceptTask({
    campaignProfileId: 'p1', campaignProfileName: 'patrick.s', sheetId: 's1', sheetUrl: 'u',
    account: { name: 'Patrick Smith', profileUrl: 'https://lnkd/in/patrick' },
    primaryUrl: 'https://lnkd/in/you', now: 5_000,
  });
  assert.equal(t.type, 'accept');
  assert.equal(t.dueAt, 5_000);
  assert.equal(t.account.name, 'Patrick Smith');
});

test('dedupeKey distinguishes type + profile + lead', () => {
  const f = buildFollowUpTask({ campaignProfileId: 'p1', leadUrl: 'L', now: 0, delayMinutes: 1 });
  const a = buildAcceptTask({ campaignProfileId: 'p1', now: 0 });
  assert.equal(dedupeKey(f), 'follow-up:p1:L');
  assert.equal(dedupeKey(a), 'accept:p1');
  assert.notEqual(dedupeKey(f), dedupeKey(a));
});

test('selectDue returns only pending tasks at or before now', () => {
  const tasks = [
    { id: '1', status: 'pending', dueAt: 100 },
    { id: '2', status: 'pending', dueAt: 300 },
    { id: '3', status: 'done', dueAt: 50 },
  ];
  const due = selectDue(tasks, 200);
  assert.deepEqual(due.map(t => t.id), ['1']);
});

test('partitionByBrowser splits local vs per-account', () => {
  const due = [
    { id: 'a', type: 'accept', sender: undefined },
    { id: 'f1', type: 'follow-up', sender: 'local-browser' },
    { id: 'f2', type: 'follow-up', sender: 'p9' },
    { id: 'f3', type: 'follow-up', sender: 'p9' },
  ];
  const { local, byAccount } = partitionByBrowser(due);
  assert.deepEqual(local.map(t => t.id), ['a', 'f1']);
  assert.deepEqual(byAccount.p9.map(t => t.id), ['f2', 'f3']);
});

test('enqueue → load round-trips and dedupes pending equivalents', async () => {
  const file = tmpFile();
  const t1 = buildAcceptTask({ campaignProfileId: 'p1', now: 1 });
  const stored = await enqueuePrimaryTask(t1, file);
  assert.ok(stored.id);
  const dup = await enqueuePrimaryTask(buildAcceptTask({ campaignProfileId: 'p1', now: 2 }), file);
  assert.equal(dup, null, 'duplicate pending accept for same profile is skipped');
  const all = await loadTasks(file);
  assert.equal(all.length, 1);
  rmSync(file, { force: true });
});

test('markTask updates status + patch; resetInProgress recovers stuck tasks', async () => {
  const file = tmpFile();
  const t = await enqueuePrimaryTask(buildAcceptTask({ campaignProfileId: 'p2', now: 1 }), file);
  await markTask(t.id, 'in_progress', {}, file);
  await resetInProgress(file);
  const all = await loadTasks(file);
  assert.equal(all[0].status, 'pending');
  await markTask(t.id, 'failed', { lastError: 'boom' }, file);
  const after = await loadTasks(file);
  assert.equal(after[0].status, 'failed');
  assert.equal(after[0].lastError, 'boom');
  rmSync(file, { force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/primary-tasks.test.js`
Expected: FAIL — `Cannot find module '../src/primary-tasks.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/primary-tasks.js`:
```javascript
/**
 * src/primary-tasks.js — the persisted queue behind primary-side automation.
 *
 * Two task types: 'accept' (local browser accepts the primary's incoming
 * invitation from a campaign account) and 'follow-up' (post-intro first
 * message in the group thread, from you or the campaign account). Pure
 * persistence + selection + builders — no Puppeteer, no campaign import. The
 * file path is injectable so tests run against a temp file.
 */
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dataPath } from './paths.js';

export const PRIMARY_TASKS_FILE = dataPath('primary-tasks.json');

function slug(v) { return String(v || '').trim(); }

/** Stable dedupe identity: a pending task already covering the same work. */
export function dedupeKey(task) {
  if (task.type === 'accept') return `accept:${task.campaignProfileId}`;
  return `follow-up:${task.campaignProfileId}:${task.leadUrl || ''}`;
}

export function buildFollowUpTask({
  campaignProfileId, campaignProfileName = '', sheetId = '', sheetUrl = '',
  sender = 'local-browser', threadUrl = '', introTitle = '',
  leadName = '', leadUrl = '', primaryName = '', primaryUrl = '', body = '',
  delayMinutes = 10, now,
}) {
  const created = Number.isFinite(now) ? now : Date.now();
  const delay = Number(delayMinutes) > 0 ? Number(delayMinutes) : 10;
  return {
    id: `follow-up:${campaignProfileId}:${slug(leadUrl) || 'lead'}:${created}`,
    type: 'follow-up', status: 'pending', attempts: 0, lastError: null,
    createdAt: created, dueAt: created + delay * 60_000,
    campaignProfileId, campaignProfileName, sheetId, sheetUrl,
    sender, threadUrl, introTitle, leadName, leadUrl, primaryName, primaryUrl, body,
  };
}

export function buildAcceptTask({
  campaignProfileId, campaignProfileName = '', sheetId = '', sheetUrl = '',
  account = { name: '', profileUrl: '' }, primaryUrl = '', now,
}) {
  const created = Number.isFinite(now) ? now : Date.now();
  return {
    id: `accept:${campaignProfileId}:${created}`,
    type: 'accept', status: 'pending', attempts: 0, lastError: null,
    createdAt: created, dueAt: created,
    campaignProfileId, campaignProfileName, sheetId, sheetUrl,
    account, primaryUrl,
  };
}

/** Pure: pending tasks whose dueAt has arrived. */
export function selectDue(tasks, now) {
  return (tasks || []).filter(t => t && t.status === 'pending' && t.dueAt <= now);
}

/** Pure: split due tasks into the local-browser bucket and per-account buckets. */
export function partitionByBrowser(due) {
  const local = [];
  const byAccount = {};
  for (const t of due) {
    if (t.type === 'accept' || t.sender === 'local-browser') {
      local.push(t);
    } else {
      (byAccount[t.sender] ||= []).push(t);
    }
  }
  return { local, byAccount };
}

export async function loadTasks(file = PRIMARY_TASKS_FILE) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveTasks(tasks, file = PRIMARY_TASKS_FILE) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(tasks, null, 2));
  await rename(tmp, file);
}

/** Append a task unless an equivalent pending one already exists. Returns the
 *  stored task, or null if it was a duplicate. */
export async function enqueuePrimaryTask(task, file = PRIMARY_TASKS_FILE) {
  const tasks = await loadTasks(file);
  const key = dedupeKey(task);
  if (tasks.some(t => t.status === 'pending' && dedupeKey(t) === key)) return null;
  tasks.push(task);
  await saveTasks(tasks, file);
  return task;
}

export async function markTask(id, status, patch = {}, file = PRIMARY_TASKS_FILE) {
  const tasks = await loadTasks(file);
  const t = tasks.find(x => x.id === id);
  if (!t) return false;
  t.status = status;
  Object.assign(t, patch);
  await saveTasks(tasks, file);
  return true;
}

/** Boot recovery: a task left 'in_progress' by a crash is reset to pending. */
export async function resetInProgress(file = PRIMARY_TASKS_FILE) {
  const tasks = await loadTasks(file);
  let changed = false;
  for (const t of tasks) {
    if (t.status === 'in_progress') { t.status = 'pending'; changed = true; }
  }
  if (changed) await saveTasks(tasks, file);
  return changed;
}

export async function clearTasksFile(file = PRIMARY_TASKS_FILE) {
  try { await unlink(file); } catch { /* not there is fine */ }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/primary-tasks.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/primary-tasks.js tests/primary-tasks.test.js
git commit -m "feat: primary-tasks queue core (builders, selection, persistence)"
```

---

## Task 2: New template fields in `normalizeTemplates`

Thread the 5 config fields through the canonical template normalizer so every in-campaign + monitoring path carries them. `monitoring-persistence.js` already persists the whole `templates` object (MONITORING_FIELDS includes `'templates'`), so no change is needed there.

**Files:**
- Modify: `src/campaign.js` (the `normalizeTemplates` return object, currently `:1264`–`:1300`)
- Test: `tests/normalize-templates-primary.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/normalize-templates-primary.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTemplates } from '../src/campaign.js';

test('normalizeTemplates passes through the new primary-side fields with safe defaults', () => {
  const t = normalizeTemplates({}, 'connect_and_introduce');
  assert.equal(t.autoAcceptPrimary, false);
  assert.equal(t.followUpEnabled, false);
  assert.equal(t.followUpBody, '');
  assert.equal(t.followUpDelayMinutes, 10);
  assert.equal(t.followUpSender, 'local-browser');
});

test('normalizeTemplates honors provided primary-side values', () => {
  const t = normalizeTemplates({
    autoAcceptPrimary: true,
    followUpEnabled: true,
    followUpBody: '  Hi {first name}  ',
    followUpDelayMinutes: '25',
    followUpSender: 'campaign-account',
  }, 'connect_and_introduce');
  assert.equal(t.autoAcceptPrimary, true);
  assert.equal(t.followUpEnabled, true);
  assert.equal(t.followUpBody, 'Hi {first name}');
  assert.equal(t.followUpDelayMinutes, 25);
  assert.equal(t.followUpSender, 'campaign-account');
});

test('followUpSender falls back to local-browser for unknown values', () => {
  const t = normalizeTemplates({ followUpSender: 'nonsense' }, 'connect_and_introduce');
  assert.equal(t.followUpSender, 'local-browser');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/normalize-templates-primary.test.js`
Expected: FAIL — `autoAcceptPrimary` is `undefined`, not `false`.

- [ ] **Step 3: Add the fields**

In `src/campaign.js`, inside the object returned by `normalizeTemplates`, immediately after the `primaryIntroBody: templates.primaryIntroBody,` line (currently `:1298`), add:
```javascript
    // v2.91: primary-side automation config (see primary-side-automation spec).
    // autoAcceptPrimary — local browser auto-accepts the primary's incoming
    // invite from a campaign account. followUp* — automated first follow-up in
    // the intro's group thread. followUpSender: 'local-browser' (you) | 'campaign-account'.
    autoAcceptPrimary: !!templates.autoAcceptPrimary,
    followUpEnabled: !!templates.followUpEnabled,
    followUpBody: (templates.followUpBody || '').trim(),
    followUpDelayMinutes: Number(templates.followUpDelayMinutes) > 0 ? Number(templates.followUpDelayMinutes) : 10,
    followUpSender: templates.followUpSender === 'campaign-account' ? 'campaign-account' : 'local-browser',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/normalize-templates-primary.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test tests/*.test.js`
Expected: All pass (pre-existing green tests stay green).

- [ ] **Step 6: Commit**

```bash
git add src/campaign.js tests/normalize-templates-primary.test.js
git commit -m "feat: thread primary-side automation fields through normalizeTemplates"
```

---

## Task 3: Accept-invitation primitive (`src/linkedin/accept-invitation.js`)

Net-new browser primitives in a NEW file (off-limits files untouched). The pure matching decision reuses `matchPrimaryCandidate` and is unit-tested; the two DOM functions are implemented with selectors and verified manually (codebase convention — no brittle DOM unit tests).

**Files:**
- Create: `src/linkedin/accept-invitation.js`
- Test: `tests/accept-invitation-pick.test.js`

- [ ] **Step 1: Write the failing test (pure matcher only)**

Create `tests/accept-invitation-pick.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickInvitation } from '../src/linkedin/accept-invitation.js';

test('pickInvitation matches the sender by name', () => {
  const candidates = [
    { name: 'Alice Brown', profileUrl: 'https://lnkd/in/alice' },
    { name: 'Patrick Smith', profileUrl: 'https://lnkd/in/patrick' },
  ];
  const r = pickInvitation(candidates, { name: 'Patrick Smith', profileUrl: '' });
  assert.equal(r.index, 1);
  assert.ok(r.reason);
});

test('pickInvitation returns no-match when nobody matches', () => {
  const candidates = [{ name: 'Alice Brown', profileUrl: '' }];
  const r = pickInvitation(candidates, { name: 'Patrick Smith', profileUrl: '' });
  assert.equal(r.index, null);
});

test('pickInvitation prefers an exact profileUrl corroboration when present', () => {
  const candidates = [
    { name: 'Pat S.', profileUrl: 'https://www.linkedin.com/in/patrick-smith' },
    { name: 'Patrick Smith', profileUrl: 'https://www.linkedin.com/in/someone-else' },
  ];
  const r = pickInvitation(candidates, {
    name: 'Patrick Smith', profileUrl: 'https://www.linkedin.com/in/patrick-smith',
  });
  assert.equal(r.index, 0);
  assert.equal(r.reason, 'profile-url');
});

test('pickInvitation accepts nothing on empty candidates', () => {
  assert.equal(pickInvitation([], { name: 'X' }).index, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/accept-invitation-pick.test.js`
Expected: FAIL — `Cannot find module '../src/linkedin/accept-invitation.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/linkedin/accept-invitation.js`:
```javascript
/**
 * src/linkedin/accept-invitation.js — net-new (the codebase has NO accept-
 * invitation capability). Lets the primary's LOCAL browser accept exactly the
 * incoming connection request sent by a known campaign account — never any
 * other invitation. The off-limits actions.js/outreach.js are NOT touched.
 *
 * pickInvitation is pure (reuses the existing matchPrimaryCandidate); the two
 * DOM functions are verified manually against LinkedIn, like other primitives.
 */
import { matchPrimaryCandidate, normalizeName } from './match-primary.js';

function urlKey(u) {
  // Compare LinkedIn profile URLs ignoring scheme/host/query/trailing slash.
  const m = String(u || '').match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Pure decision: which received-invitation candidate (if any) belongs to the
 * target campaign account. Profile-URL match wins; else fall back to the name
 * matcher already used for the intro typeahead.
 * @param {Array<{name:string, profileUrl?:string}>} candidates
 * @param {{name:string, profileUrl?:string}} target
 * @returns {{ index: number|null, reason: string }}
 */
export function pickInvitation(candidates, target) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { index: null, reason: 'no-candidates' };
  }
  const tUrl = urlKey(target && target.profileUrl);
  if (tUrl) {
    const i = candidates.findIndex(c => urlKey(c.profileUrl) === tUrl);
    if (i >= 0) return { index: i, reason: 'profile-url' };
  }
  const byName = matchPrimaryCandidate(
    candidates.map(c => ({ text: c.name })),
    (target && target.name) || '',
  );
  if (byName.matchIndex != null) return { index: byName.matchIndex, reason: byName.reason };
  return { index: null, reason: 'no-match' };
}

/**
 * Read the logged-in account's OWN identity from the global nav. Works on any
 * LinkedIn page (the "Me" control is global), so it can run on the campaign
 * account right after it sends the connect request to the primary.
 * @returns {Promise<{name:string, profileUrl:string}>}
 */
export async function readSelfIdentity(page) {
  try {
    return await page.evaluate(() => {
      const out = { name: '', profileUrl: '' };
      const meImg = document.querySelector('img.global-nav__me-photo, .global-nav__me img');
      if (meImg && meImg.alt) out.name = meImg.alt.replace(/\s+/g, ' ').trim();
      // The "View Profile" link in the Me dropdown carries the own profile URL.
      const link = document.querySelector('a[href*="/in/"]:not([href*="/detail/"])');
      if (link) out.profileUrl = link.href;
      return out;
    });
  } catch {
    return { name: '', profileUrl: '' };
  }
}

/**
 * On the LOCAL browser (= the primary), accept ONLY the invitation matching
 * `target`. If none matches, accept nothing.
 * @returns {Promise<{accepted:boolean, reason:string}>}
 */
export async function acceptInvitationFrom(page, target, { log = () => {} } = {}) {
  await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/received/', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  await new Promise(r => setTimeout(r, 2500));

  const candidates = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(
      '.invitation-card, li.mn-invitation-list__item, [data-view-name="pending-invitation"]',
    ));
    return rows.map((row, idx) => {
      const nameEl = row.querySelector('a[href*="/in/"] strong, .invitation-card__title, a[href*="/in/"]');
      const link = row.querySelector('a[href*="/in/"]');
      return {
        idx,
        name: (nameEl?.textContent || '').replace(/\s+/g, ' ').trim(),
        profileUrl: link?.href || '',
      };
    });
  });

  const { index, reason } = pickInvitation(candidates, target);
  if (index == null) {
    log(`  ⚠ Auto-accept: no pending invitation matches ${target?.name || 'the account'} (${reason}) — accepting nothing.`);
    return { accepted: false, reason };
  }

  const clicked = await page.evaluate((wantIdx) => {
    const rows = Array.from(document.querySelectorAll(
      '.invitation-card, li.mn-invitation-list__item, [data-view-name="pending-invitation"]',
    ));
    const row = rows[wantIdx];
    if (!row) return false;
    const btn = Array.from(row.querySelectorAll('button'))
      .find(b => /accept/i.test(b.textContent || '') || /accept/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, index);

  if (!clicked) return { accepted: false, reason: 'accept-button-not-found' };
  await new Promise(r => setTimeout(r, 1500));
  log(`  ✓ Auto-accept: accepted the invitation from ${target?.name || 'the account'} (${reason}).`);
  return { accepted: true, reason };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/accept-invitation-pick.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/accept-invitation.js tests/accept-invitation-pick.test.js
git commit -m "feat: accept-invitation primitive (pure matcher + DOM accept/self-identity)"
```

---

## Task 4: Thread-message primitive (`src/linkedin/thread-message.js`)

Reopen the intro's group thread by URL and post the follow-up. Net-new file. A pure URL-sanity helper is unit-tested; the DOM send is verified manually.

**Files:**
- Create: `src/linkedin/thread-message.js`
- Test: `tests/thread-message-url.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/thread-message-url.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUsableThreadUrl } from '../src/linkedin/thread-message.js';

test('isUsableThreadUrl accepts a real messaging thread URL', () => {
  assert.equal(isUsableThreadUrl('https://www.linkedin.com/messaging/thread/2-abc==/'), true);
});

test('isUsableThreadUrl rejects compose / feed / empty URLs', () => {
  assert.equal(isUsableThreadUrl('https://www.linkedin.com/messaging/compose/'), false);
  assert.equal(isUsableThreadUrl('https://www.linkedin.com/feed/'), false);
  assert.equal(isUsableThreadUrl(''), false);
  assert.equal(isUsableThreadUrl(null), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/thread-message-url.test.js`
Expected: FAIL — `Cannot find module '../src/linkedin/thread-message.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/linkedin/thread-message.js`:
```javascript
/**
 * src/linkedin/thread-message.js — net-new. Reopen a known group thread (the
 * one created when the intro was sent) and post the automated first follow-up.
 * Off-limits actions.js/outreach.js are NOT touched.
 *
 * isUsableThreadUrl is pure + tested; sendInThread is verified manually.
 */

/** A captured page.url() is a usable thread target only if it's a real
 *  /messaging/thread/<id> URL — not a /compose, /feed, or empty fallback. */
export function isUsableThreadUrl(url) {
  if (!url) return false;
  return /\/messaging\/thread\/[^/?#]+/.test(String(url));
}

/**
 * Type `body` into the composer of the thread at `threadUrl` and send it.
 * Falls back to searching messaging by lead name when the URL is unusable.
 * Throws on failure so the runner can mark the task failed/retry.
 */
export async function sendInThread(page, threadUrl, body, { introTitle = '', leadName = '', log = () => {} } = {}) {
  if (!body || !body.trim()) throw new Error('FOLLOWUP_EMPTY_BODY');

  let target = threadUrl;
  if (!isUsableThreadUrl(target)) {
    log(`  ↻ Follow-up: thread URL unusable, searching messaging for "${leadName}"…`);
    target = await _findThreadByLead(page, leadName, introTitle);
    if (!target) throw new Error('FOLLOWUP_THREAD_NOT_FOUND');
  }

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2500));

  const box = await page.waitForSelector(
    'div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
    { timeout: 15000 },
  ).catch(() => null);
  if (!box) throw new Error('FOLLOWUP_COMPOSER_NOT_FOUND');

  await box.click();
  await page.keyboard.type(body, { delay: 12 });
  await new Promise(r => setTimeout(r, 400));

  const sent = await page.evaluate(() => {
    const btn = document.querySelector('button.msg-form__send-button, button[type="submit"].msg-form__send-button');
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  });
  if (!sent) {
    await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta');
  }
  await new Promise(r => setTimeout(r, 1500));
  log(`  ✓ Follow-up sent in the group thread${leadName ? ` (${leadName})` : ''}.`);
}

async function _findThreadByLead(page, leadName, introTitle) {
  try {
    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    const needle = (leadName || introTitle || '').trim();
    if (!needle) return '';
    return await page.evaluate((want) => {
      const rows = Array.from(document.querySelectorAll('a.msg-conversation-listitem__link, a[href*="/messaging/thread/"]'));
      const lc = want.toLowerCase();
      const hit = rows.find(a => (a.textContent || '').toLowerCase().includes(lc));
      return hit ? hit.href : '';
    }, needle);
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/thread-message-url.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/thread-message.js tests/thread-message-url.test.js
git commit -m "feat: thread-message primitive for the automated first follow-up"
```

---

## Task 5: Enqueue the follow-up inside `runAutoIntros`

Because all 4 intro paths funnel through `runAutoIntros`, enqueuing here makes the follow-up fire in-campaign, in monitoring, in the scheduled sweep, and on "run bulk check now" — with no new triggers. Enqueue only on a fresh successful send (`ok`), capturing the group-thread URL from `page.url()`.

**Files:**
- Modify: `src/linkedin/auto-intro.js` (imports near `:22`; enqueue in the `if (ok)` branch near `:504`–`:510`)
- Test: `tests/auto-intro-followup-enqueue.test.js`

- [ ] **Step 1: Add imports**

In `src/linkedin/auto-intro.js`, after the existing `import { personalizeTemplate, getConnectionStatus } from './helpers.js';` (`:22`), add:
```javascript
import { extractSheetId } from '../utils.js';
import { buildFollowUpTask, enqueuePrimaryTask } from '../primary-tasks.js';
```

- [ ] **Step 2: Write the failing test**

Create `tests/auto-intro-followup-enqueue.test.js`. This tests the small pure helper we extract (`maybeBuildFollowUp`) so we avoid driving the whole `runAutoIntros` with a browser:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeBuildFollowUp } from '../src/linkedin/auto-intro.js';

const base = {
  tpl: { followUpEnabled: true, followUpBody: 'Hi {first name}', followUpDelayMinutes: 10, followUpSender: 'local-browser',
         primaryName: 'You', primaryUrl: 'https://lnkd/in/you', introTitle: 'Intro' },
  introData: { 'first name': 'Jane', firstName: 'Jane', company: 'Acme' },
  profileId: 'p1', profileName: 'patrick.s', sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET123/edit',
  leadName: 'Jane Doe', url: 'https://www.linkedin.com/in/jane',
  threadUrl: 'https://www.linkedin.com/messaging/thread/2-abc==/', now: 1000,
};

test('maybeBuildFollowUp renders body + sets due time when enabled', () => {
  const t = maybeBuildFollowUp(base);
  assert.ok(t);
  assert.equal(t.type, 'follow-up');
  assert.equal(t.body, 'Hi Jane');
  assert.equal(t.sender, 'local-browser');
  assert.equal(t.dueAt, 1000 + 10 * 60_000);
  assert.equal(t.sheetId, 'SHEET123');
  assert.equal(t.threadUrl, base.threadUrl);
});

test('maybeBuildFollowUp returns null when disabled', () => {
  assert.equal(maybeBuildFollowUp({ ...base, tpl: { ...base.tpl, followUpEnabled: false } }), null);
});

test('maybeBuildFollowUp returns null when body is blank', () => {
  assert.equal(maybeBuildFollowUp({ ...base, tpl: { ...base.tpl, followUpBody: '   ' } }), null);
});

test('maybeBuildFollowUp resolves campaign-account sender to the profileId', () => {
  const t = maybeBuildFollowUp({ ...base, tpl: { ...base.tpl, followUpSender: 'campaign-account' } });
  assert.equal(t.sender, 'p1');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/auto-intro-followup-enqueue.test.js`
Expected: FAIL — `maybeBuildFollowUp` is not exported.

- [ ] **Step 4: Add the pure helper (exported) to `auto-intro.js`**

Near the top of `src/linkedin/auto-intro.js` (after the imports), add this exported pure helper:
```javascript
/**
 * v2.91: build the follow-up task for one freshly-sent intro, or null when the
 * follow-up is disabled / has no body. Pure — the enqueue side-effect happens
 * at the call site. sender 'campaign-account' is resolved to this profileId so
 * the runner opens the right browser.
 */
export function maybeBuildFollowUp({ tpl, introData, profileId, profileName, sheetUrl, leadName, url, threadUrl, now }) {
  if (!tpl || !tpl.followUpEnabled) return null;
  const rawBody = (tpl.followUpBody || '').trim();
  if (!rawBody) return null;
  const body = personalizeTemplate(rawBody, introData);
  const sender = tpl.followUpSender === 'campaign-account' ? profileId : 'local-browser';
  return buildFollowUpTask({
    campaignProfileId: profileId,
    campaignProfileName: profileName,
    sheetId: extractSheetId(sheetUrl) || '',
    sheetUrl,
    sender,
    threadUrl,
    introTitle: tpl.introTitle || '',
    leadName,
    leadUrl: url,
    primaryName: tpl.primaryName || '',
    primaryUrl: tpl.primaryUrl || '',
    body,
    delayMinutes: tpl.followUpDelayMinutes,
    now: Number.isFinite(now) ? now : Date.now(),
  });
}
```

- [ ] **Step 5: Call it from the `if (ok)` success branch**

In `src/linkedin/auto-intro.js`, inside the `if (ok) {` branch (currently `:504`–`:510`), after `log(\`  🤝 [${profileName}] ${url}: Introduction Made\`);`, add:
```javascript
      // v2.91: queue the automated first follow-up. page is still on the group
      // thread here (compose redirected to /messaging/thread/...), so capture it.
      try {
        let _threadUrl = '';
        try { _threadUrl = page.url(); } catch { /* */ }
        const _fu = maybeBuildFollowUp({
          tpl, introData, profileId, profileName, sheetUrl,
          leadName: `${leadFirstName} ${leadLastName}`.trim() || url,
          url, threadUrl: _threadUrl,
        });
        if (_fu) {
          const stored = await enqueuePrimaryTask(_fu);
          if (stored) log(`  ⏳ [${profileName}] ${url}: Follow-up queued · due ${new Date(stored.dueAt).toLocaleTimeString()} · from ${_fu.sender === 'local-browser' ? 'you' : profileName}`);
        }
      } catch (e) {
        log(`  ⚠ [${profileName}] Follow-up queue warning: ${e.message}`);
      }
```

Note: this branch passes `profileId`. Confirm `profileId` is in scope at this line (it is — it's a `runAutoIntros` destructured param). If the local variable is named differently in the loop, use the destructured param name.

- [ ] **Step 6: Run the test + full suite**

Run: `node --test tests/auto-intro-followup-enqueue.test.js`
Expected: PASS (4 tests).

Run: `node --test tests/*.test.js`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/linkedin/auto-intro.js tests/auto-intro-followup-enqueue.test.js
git commit -m "feat: enqueue automated first follow-up on every successful intro"
```

---

## Task 6: Enqueue the accept task at the connect-to-primary site

When a campaign account sends its connect request to the primary, capture the account's own identity and enqueue an `accept` task — only when `autoAcceptPrimary` is on.

**Files:**
- Modify: `src/campaign.js` (imports near top; the connect-to-primary block at `:2401`–`:2413`)
- Test: `tests/accept-task-build.test.js`

- [ ] **Step 1: Add imports**

In `src/campaign.js`, near the other `src/linkedin` and queue imports at the top, add:
```javascript
import { readSelfIdentity } from './linkedin/accept-invitation.js';
import { buildAcceptTask, enqueuePrimaryTask } from './primary-tasks.js';
```

- [ ] **Step 2: Write the failing test (pure build path)**

Create `tests/accept-task-build.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptTask, dedupeKey } from '../src/primary-tasks.js';

test('an accept task for a connect-sent account is well-formed and due now', () => {
  const t = buildAcceptTask({
    campaignProfileId: '690d',
    campaignProfileName: 'patrick.s',
    sheetId: 'SHEET123',
    sheetUrl: 'u',
    account: { name: 'Patrick Smith', profileUrl: 'https://lnkd/in/patrick' },
    primaryUrl: 'https://lnkd/in/you',
    now: 7,
  });
  assert.equal(t.type, 'accept');
  assert.equal(t.status, 'pending');
  assert.equal(t.dueAt, 7);
  assert.equal(dedupeKey(t), 'accept:690d');
});
```

- [ ] **Step 3: Run it to verify it passes already (guards the shape) — then add the enqueue wiring**

Run: `node --test tests/accept-task-build.test.js`
Expected: PASS (this guards the task shape the wiring depends on).

In `src/campaign.js`, inside the connect-to-primary block, change the `_prev !== 'connected'` body (currently `:2403`–`:2412`) so that after `campaign._primaryConn.set(profileId, ...)` it enqueues the accept task. Replace:
```javascript
            if (_prev !== 'connected') {
              try {
                const _res = await checkAndConnectPrimary(page, _primaryUrl, {
                  log, pName, attemptConnect: (_prev === undefined || _prev === 'no_url'),
                });
                campaign._primaryConn.set(profileId, _res.connected ? 'connected' : 'pending');
              } catch (e) {
                log(`  ⚠ [${pName}] Primary check error: ${e.message}`);
              }
            }
```
with:
```javascript
            if (_prev !== 'connected') {
              try {
                const _res = await checkAndConnectPrimary(page, _primaryUrl, {
                  log, pName, attemptConnect: (_prev === undefined || _prev === 'no_url'),
                });
                campaign._primaryConn.set(profileId, _res.connected ? 'connected' : 'pending');
                // v2.91: if we just sent a connect to the primary AND auto-accept
                // is enabled, capture this account's own identity and queue the
                // local browser to accept its invitation in the next idle gap.
                if (tpl && tpl.autoAcceptPrimary && _res.connectAttempted && _res.connectResult === 'sent') {
                  try {
                    const _self = await readSelfIdentity(page);
                    const _task = buildAcceptTask({
                      campaignProfileId: profileId,
                      campaignProfileName: pName,
                      sheetId: _extractSheetIdFromUrl(sheetUrl) || '',
                      sheetUrl,
                      account: _self,
                      primaryUrl: _primaryUrl,
                    });
                    const _stored = await enqueuePrimaryTask(_task);
                    if (_stored) log(`  ⏳ [${pName}] Auto-accept queued — your local browser will accept this account's invite at the next idle moment.`);
                  } catch (e) {
                    log(`  ⚠ [${pName}] Auto-accept queue warning: ${e.message}`);
                  }
                }
              } catch (e) {
                log(`  ⚠ [${pName}] Primary check error: ${e.message}`);
              }
            }
```

Note: confirm the local sheet-id helper is named `_extractSheetIdFromUrl` (it is, used at `:2239`, `:4082`, etc.) and that `sheetUrl` and `tpl` are in scope at this point in the batch loop (they are).

- [ ] **Step 4: Run the full suite**

Run: `node --test tests/*.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/campaign.js tests/accept-task-build.test.js
git commit -m "feat: queue auto-accept task when an account connects to the primary"
```

---

## Task 7: The safe-window runner (`src/primary-task-runner.js`)

Drains due tasks one browser at a time, gated on full idle. Core `runDueTasks` takes injected deps so it's testable without a real browser; `shouldRun` is pure.

**Files:**
- Create: `src/primary-task-runner.js`
- Test: `tests/primary-task-runner.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/primary-task-runner.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRun, runDueTasks } from '../src/primary-task-runner.js';

test('shouldRun only when no campaign and no browser open', () => {
  assert.equal(shouldRun({ campaignRunning: false, browserCount: 0 }), true);
  assert.equal(shouldRun({ campaignRunning: true, browserCount: 0 }), false);
  assert.equal(shouldRun({ campaignRunning: false, browserCount: 1 }), false);
});

function fakeSemaphore() {
  const calls = { acquire: 0, release: 0 };
  return { calls, async acquire() { calls.acquire++; }, release() { calls.release++; }, getStatus() { return { count: 0, max: 2 }; } };
}

test('runDueTasks accepts the matching invite and marks it done', async () => {
  const marks = [];
  const tasks = [{ id: 'a1', type: 'accept', status: 'pending', dueAt: 1, account: { name: 'Pat' }, attempts: 0 }];
  const sem = fakeSemaphore();
  const res = await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status) => { marks.push([id, status]); },
    launchLocal: async () => ({ browser: {}, page: { _local: true } }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }),
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true, reason: 'name' }),
    sendInThread: async () => {},
    semaphore: sem,
    log: () => {},
  });
  assert.equal(res.ran, 1);
  assert.deepEqual(marks, [['a1', 'done']]);
  assert.equal(sem.calls.acquire, 1);
  assert.equal(sem.calls.release, 1);
});

test('runDueTasks sends a campaign-account follow-up via launchAccount', async () => {
  const marks = [];
  const opened = [];
  const tasks = [{ id: 'f1', type: 'follow-up', sender: 'p9', status: 'pending', dueAt: 1, threadUrl: 'https://www.linkedin.com/messaging/thread/x', body: 'hi', attempts: 0 }];
  const res = await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status) => marks.push([id, status]),
    launchLocal: async () => ({ page: {} }),
    closeLocal: async () => {},
    launchAccount: async (pid) => { opened.push(pid); return { page: {} }; },
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }),
    sendInThread: async () => {},
    semaphore: fakeSemaphore(),
    log: () => {},
  });
  assert.equal(res.ran, 1);
  assert.deepEqual(opened, ['p9']);
  assert.deepEqual(marks, [['f1', 'done']]);
});

test('runDueTasks retries (stays pending) up to 3 attempts then fails', async () => {
  const marks = [];
  const tasks = [{ id: 'f1', type: 'follow-up', sender: 'local-browser', status: 'pending', dueAt: 1, threadUrl: 't', body: 'hi', attempts: 2 }];
  await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status, patch) => marks.push([id, status, patch.attempts]),
    launchLocal: async () => ({ page: {} }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }),
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }),
    sendInThread: async () => { throw new Error('not logged in'); },
    semaphore: fakeSemaphore(),
    log: () => {},
  });
  assert.deepEqual(marks, [['f1', 'failed', 3]]);
});

test('runDueTasks does nothing when no tasks are due', async () => {
  const res = await runDueTasks(10, {
    loadTasks: async () => [{ id: 'x', type: 'accept', status: 'pending', dueAt: 999 }],
    markTask: async () => { throw new Error('should not mark'); },
    launchLocal: async () => { throw new Error('should not launch'); },
    closeLocal: async () => {}, launchAccount: async () => ({}), closeAccount: async () => {},
    acceptInvitationFrom: async () => ({}), sendInThread: async () => {},
    semaphore: fakeSemaphore(), log: () => {},
  });
  assert.equal(res.ran, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/primary-task-runner.test.js`
Expected: FAIL — `Cannot find module '../src/primary-task-runner.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/primary-task-runner.js`:
```javascript
/**
 * src/primary-task-runner.js — the safe-window runner. Every 60s, when nothing
 * else has a browser open (browser-semaphore count 0) and no campaign is
 * running, it drains due primary tasks ONE browser at a time: the local browser
 * for accepts + your-side follow-ups; the specific gologin account for
 * campaign-account follow-ups. runDueTasks takes injected deps so it's testable
 * without a real browser.
 */
import * as browserSemaphore from './browser-semaphore.js';
import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
import { launchProfile, closeProfile } from './gologin-launcher.js';
import { acceptInvitationFrom } from './linkedin/accept-invitation.js';
import { sendInThread } from './linkedin/thread-message.js';
import { appendCampaignLog } from './campaign-log-bus.js';
import {
  loadTasks as _loadTasks, markTask as _markTask, resetInProgress,
  selectDue, partitionByBrowser,
} from './primary-tasks.js';

const MAX_ATTEMPTS = 3;
let _timer = null;

/** Pure gate: only act when the whole app is idle. */
export function shouldRun({ campaignRunning, browserCount }) {
  return !campaignRunning && browserCount === 0;
}

async function _settleFailure(task, err, markTask) {
  const attempts = (task.attempts || 0) + 1;
  const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await markTask(task.id, status, { attempts, lastError: err.message || String(err) });
}

/** Core drain loop. deps are injected for testing. */
export async function runDueTasks(now, deps) {
  const {
    loadTasks, markTask, launchLocal, closeLocal, launchAccount, closeAccount,
    acceptInvitationFrom: acceptFn, sendInThread: sendFn, semaphore, log,
  } = deps;

  const due = selectDue(await loadTasks(), now);
  if (due.length === 0) return { ran: 0 };
  const { local, byAccount } = partitionByBrowser(due);
  let ran = 0;

  if (local.length) {
    await semaphore.acquire();
    try {
      const { page } = await launchLocal();
      for (const t of local) {
        try {
          if (t.type === 'accept') {
            const r = await acceptFn(page, t.account, { log });
            await markTask(t.id, r.accepted ? 'done' : 'skipped', { lastError: r.reason || null });
          } else {
            await sendFn(page, t.threadUrl, t.body, { introTitle: t.introTitle, leadName: t.leadName, log });
            await markTask(t.id, 'done', {});
          }
          ran++;
        } catch (e) {
          await _settleFailure(t, e, markTask);
        }
      }
    } catch (e) {
      log(`  ⚠ Primary runner: local browser session failed: ${e.message}`);
    } finally {
      try { await closeLocal(); } catch { /* */ }
      semaphore.release();
    }
  }

  for (const [profileId, list] of Object.entries(byAccount)) {
    await semaphore.acquire();
    try {
      const { page } = await launchAccount(profileId);
      for (const t of list) {
        try {
          await sendFn(page, t.threadUrl, t.body, { introTitle: t.introTitle, leadName: t.leadName, log });
          await markTask(t.id, 'done', {});
          ran++;
        } catch (e) {
          await _settleFailure(t, e, markTask);
        }
      }
    } catch (e) {
      log(`  ⚠ Primary runner: account ${profileId} session failed: ${e.message}`);
    } finally {
      try { await closeAccount(profileId); } catch { /* */ }
      semaphore.release();
    }
  }

  return { ran };
}

async function _isCampaignRunning() {
  try { const m = await import('./campaign.js'); return !!m.campaign?.running; } catch { return false; }
}

function _log(line) {
  // Console always; live-log routing is best-effort (the task carries sheetId
  // + profile in production via the runner's per-task logger below).
  console.log(`[primary-runner] ${line}`);
}

/** Production tick — gated, then drains with the real browser deps. */
export async function tick() {
  const campaignRunning = await _isCampaignRunning();
  const { count } = browserSemaphore.getStatus();
  if (!shouldRun({ campaignRunning, browserCount: count })) return;

  const token = process.env.GOLOGIN_API_TOKEN;
  await runDueTasks(Date.now(), {
    loadTasks: _loadTasks,
    markTask: _markTask,
    launchLocal: launchLocalBrowser,
    closeLocal: closeLocalBrowser,
    launchAccount: (pid) => launchProfile(pid, token),
    closeAccount: (pid) => closeProfile(pid),
    acceptInvitationFrom,
    sendInThread,
    semaphore: browserSemaphore,
    log: (line) => _log(line),
  });
}

export function startPrimaryTaskRunner() {
  resetInProgress().catch(() => {});
  if (_timer) return;
  _timer = setInterval(() => { tick().catch(e => _log(`tick error: ${e.message}`)); }, 60 * 1000);
  if (_timer.unref) _timer.unref();
  _log('started (60s tick).');
}

export function stopPrimaryTaskRunner() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/primary-task-runner.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/primary-task-runner.js tests/primary-task-runner.test.js
git commit -m "feat: safe-window runner that drains primary tasks one browser at a time"
```

---

## Task 8: Route sweeps through the semaphore + persist follow-up config on schedule entries

Two changes so the runner's "no browser open" gate is accurate and so post-campaign follow-ups carry their config: (a) wrap both sweep launches in `browserSemaphore.acquire()/release()`; (b) persist the new template fields on the schedule entry and pass them into the sweep's `runAutoIntros`.

**Files:**
- Modify: `src/post-campaign-bulk-check.js` (import; launch at `:221`; close at `:308`; `registerSchedule` `:96`–`:128`; the `templates:` object at `:261`–`:266`)
- Modify: `src/post-campaign-reply-check.js` (import; its launch/close)
- Modify: `src/campaign.js` (the `registerPostCampaignSweep({...})` call at `:3653` — pass the new fields)
- Test: `tests/register-schedule-followup-fields.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/register-schedule-followup-fields.test.js`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

// Point the data dir at a temp folder BEFORE importing the module so its
// dataPath() resolves there.
process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'sched-'));
const mod = await import('../src/post-campaign-bulk-check.js');

test('registerSchedule persists the follow-up + auto-accept config', async () => {
  await mod.registerSchedule({
    sheetId: 'S1', sheetUrl: 'u', profileId: 'p1', profileName: 'patrick.s',
    linkedinColumn: 'LinkedIn', days: 7, mode: 'connect_and_introduce',
    primaryName: 'You', primaryIntroBody: 'intro', primaryUrl: 'https://lnkd/in/you',
    autoAcceptPrimary: true, followUpEnabled: true, followUpBody: 'Hi {first name}',
    followUpDelayMinutes: 15, followUpSender: 'campaign-account',
  });
  const sched = await mod.listSchedule();
  const entry = Object.values(sched).find(e => e.profileId === 'p1');
  assert.equal(entry.autoAcceptPrimary, true);
  assert.equal(entry.followUpEnabled, true);
  assert.equal(entry.followUpBody, 'Hi {first name}');
  assert.equal(entry.followUpDelayMinutes, 15);
  assert.equal(entry.followUpSender, 'campaign-account');
});
```
(Confirm the listing export is `listSchedule`; in `server.js` it is imported as `listSchedule as listPostCampaignSchedule`, so the export name is `listSchedule`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/register-schedule-followup-fields.test.js`
Expected: FAIL — `entry.followUpEnabled` is `undefined`.

- [ ] **Step 3: Extend `registerSchedule`**

In `src/post-campaign-bulk-check.js`, add the new params to the `registerSchedule` signature (`:96`–`:99`):
```javascript
export async function registerSchedule({ sheetId, sheetUrl, profileId, profileName, linkedinColumn, days,
                                          operatorEmail,
                                          mode = '', primaryName = '', primaryIntroBody = '',
                                          primaryUrl = '', introTitle = '', ccDmBody = '',
                                          autoAcceptPrimary = false, followUpEnabled = false,
                                          followUpBody = '', followUpDelayMinutes = 10,
                                          followUpSender = 'local-browser' }) {
```
And in the stored `sched[k] = {...}` object, after `ccDmBody: ccDmBody || '',` (`:122`), add:
```javascript
    // v2.91: primary-side automation config carried into the post-campaign sweep
    autoAcceptPrimary: !!autoAcceptPrimary,
    followUpEnabled: !!followUpEnabled,
    followUpBody: followUpBody || '',
    followUpDelayMinutes: Number(followUpDelayMinutes) > 0 ? Number(followUpDelayMinutes) : 10,
    followUpSender: followUpSender === 'campaign-account' ? 'campaign-account' : 'local-browser',
```

- [ ] **Step 4: Pass the fields into the sweep's `runAutoIntros`**

In `src/post-campaign-bulk-check.js`, in the `templates: {...}` object passed to `runAutoIntros` (`:261`–`:266`), add the new fields so the follow-up enqueue inside `runAutoIntros` sees them:
```javascript
              templates: {
                primaryName: entry.primaryName,
                primaryIntroBody: entry.primaryIntroBody,
                primaryUrl: entry.primaryUrl || '',
                introTitle: entry.introTitle || 'Introduction: {first name} <> {intro name}',
                autoAcceptPrimary: entry.autoAcceptPrimary,
                followUpEnabled: entry.followUpEnabled,
                followUpBody: entry.followUpBody,
                followUpDelayMinutes: entry.followUpDelayMinutes,
                followUpSender: entry.followUpSender,
              },
```

- [ ] **Step 5: Wrap the sweep launch in the semaphore**

In `src/post-campaign-bulk-check.js`, add the import at the top:
```javascript
import * as browserSemaphore from './browser-semaphore.js';
```
Wrap the per-entry launch (`:219`–`:226`) so the slot is acquired before launch:
```javascript
    let launched;
    await browserSemaphore.acquire();
    try {
      launched = await launchProfile(entry.profileId, token);
    } catch (err) {
      console.warn(`[post-campaign] Launch failed for ${entry.profileName}: ${err.message}`);
      browserSemaphore.release();
      continue;
    }
```
And release the slot where the profile is closed (`:308`, currently `try { await closeProfile(entry.profileId); } catch { ... }`):
```javascript
      try { await closeProfile(entry.profileId); } catch { /* */ }
      browserSemaphore.release();
```
Confirm there is exactly one close site per entry (the `finally`). If the close is in a `finally`, place `browserSemaphore.release()` immediately after it inside the same `finally`.

- [ ] **Step 6: Mirror the semaphore wrap in the reply-check sweep**

In `src/post-campaign-reply-check.js`, add `import * as browserSemaphore from './browser-semaphore.js';`, then wrap its `launchProfile(...)` call with `await browserSemaphore.acquire();` before and `browserSemaphore.release();` in the matching close/`finally`. (Read the file's launch + close sites first; the pattern is identical to Step 5.)

- [ ] **Step 7: Pass the new fields at the registerSchedule call site**

In `src/campaign.js`, find the `registerPostCampaignSweep({...})` call (`:3653`) and add the new fields, reading them off the campaign's templates object (the same `tpl`/`campaign.templates` used elsewhere in that function):
```javascript
          autoAcceptPrimary: !!(campaign.templates && campaign.templates.autoAcceptPrimary),
          followUpEnabled: !!(campaign.templates && campaign.templates.followUpEnabled),
          followUpBody: (campaign.templates && campaign.templates.followUpBody) || '',
          followUpDelayMinutes: (campaign.templates && campaign.templates.followUpDelayMinutes) || 10,
          followUpSender: (campaign.templates && campaign.templates.followUpSender) || 'local-browser',
```
(Read the existing call to confirm the object already passes `primaryName`/`primaryUrl` from `campaign.templates`; add these adjacent, in the same style.)

- [ ] **Step 8: Run the test + full suite**

Run: `node --test tests/register-schedule-followup-fields.test.js`
Expected: PASS.

Run: `node --test tests/*.test.js`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/post-campaign-bulk-check.js src/post-campaign-reply-check.js src/campaign.js tests/register-schedule-followup-fields.test.js
git commit -m "feat: route sweeps through the browser semaphore + carry follow-up config to post-campaign"
```

---

## Task 9: Boot the runner

Start the runner alongside the other schedulers on server boot.

**Files:**
- Modify: `server.js` (imports near `:32`; boot near `:3370` after `startMonitoringWatcher()`)

- [ ] **Step 1: Add the import**

In `server.js`, after the scheduler imports (`:32`–`:33`), add:
```javascript
import { startPrimaryTaskRunner } from './src/primary-task-runner.js';
```

- [ ] **Step 2: Start it on boot**

In `server.js`, immediately after `startMonitoringWatcher();` (`:3370`), add:
```javascript
  // v2.91: drain primary-side automation tasks (auto-accept + first follow-up)
  // in idle gaps — one browser at a time, gated on the global browser semaphore.
  startPrimaryTaskRunner();
```

- [ ] **Step 3: Smoke-check the server imports cleanly**

Run: `node -e "import('./src/primary-task-runner.js').then(m => console.log('ok', typeof m.startPrimaryTaskRunner))"`
Expected: `ok function`

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: boot the primary-task runner on server start"
```

---

## Task 10: Config UI (sketch D)

Add the auto-accept toggle (gated on the primary URL), the follow-up toggle + message + delay + sender select, and wire them into the templates payload. The UI is vanilla HTML/CSS/JS — manual verification only (no UI test suite). Reuse existing `.intro-config-card` / `.intro-config-field` / `.notif-pref-toggle` classes.

**Files:**
- Modify: `public/index.html` (new cards inside `#intro-config-row`, near `:514`–`:531`)
- Modify: `public/js/app.js` (read the new fields into every templates-assembly block that already includes `primaryUrl`; add the URL-gating for the auto-accept toggle)
- Modify: `public/css/style.css` (only if a new style is needed; prefer existing tokens/classes)

- [ ] **Step 1: Add the config cards to `index.html`**

Inside `#intro-config-row` (`public/index.html:511`), after the `#primary-person-block` card (closes near `:531`) and before `#check-cadence-block` (`:532`), add two new cards:
```html
        <!-- v2.91: Auto-accept the primary connection — locked until a URL is set -->
        <div id="auto-accept-block" class="intro-config-card" style="display:none;">
          <div class="intro-config-eyebrow">Auto-accept the connection <span class="intro-config-newtag">NEW</span></div>
          <div class="intro-config-toggle-row">
            <span id="auto-accept-label" class="intro-config-toggle-key">Accept via my local browser</span>
            <label class="notif-pref-toggle" id="auto-accept-toggle-wrap">
              <input type="checkbox" id="auto-accept-toggle" disabled onchange="savePrimaryPersonFields()">
              <span class="notif-pref-slider"></span>
            </label>
          </div>
          <div id="auto-accept-gate" class="intro-config-gate">
            🔒 Add the primary person's LinkedIn URL above to switch this on — without the URL there's nothing to accept from.
          </div>
          <div class="intro-config-hint">When an account isn't connected to your primary, it requests them and your local browser accepts that one invitation automatically — no manual step before the intro.</div>
        </div>

        <!-- v2.91: Automated first follow-up -->
        <div id="follow-up-block" class="intro-config-card" style="display:none;">
          <div class="intro-config-eyebrow">Automated first follow-up <span class="intro-config-newtag">NEW</span></div>
          <div class="intro-config-toggle-row">
            <span class="intro-config-toggle-key">Send a first follow-up after the intro</span>
            <label class="notif-pref-toggle">
              <input type="checkbox" id="follow-up-toggle" onchange="savePrimaryPersonFields(); toggleFollowUpFields();">
              <span class="notif-pref-slider"></span>
            </label>
          </div>
          <div id="follow-up-fields" style="display:none;">
            <div class="intro-config-field">
              <label for="follow-up-body" class="intro-config-label">Follow-up message — posted in the same group thread</label>
              <textarea id="follow-up-body" class="intro-config-input" rows="3" placeholder="Hi {first name}, great to be connected…" oninput="savePrimaryPersonFields()"></textarea>
              <div class="intro-config-hint">Tokens: <code>{first name}</code>, <code>{company}</code>.</div>
            </div>
            <div class="intro-config-inline">
              <span class="intro-config-prefix">Send</span>
              <input type="number" id="follow-up-delay" class="intro-config-num" min="1" max="240" value="10" oninput="savePrimaryPersonFields()">
              <span class="intro-config-prefix">min after the intro · from</span>
              <select id="follow-up-sender" class="intro-config-select" onchange="savePrimaryPersonFields()">
                <option value="local-browser">you (local browser)</option>
                <option value="campaign-account">the campaign account</option>
              </select>
            </div>
          </div>
        </div>
```

- [ ] **Step 2: Show/hide the new cards with the other CC+IC cards**

In `public/js/app.js`, find where `#primary-person-block` / `#check-cadence-block` visibility is toggled by mode (search `primary-person-block`). Add `auto-accept-block` and `follow-up-block` to the same show/hide logic so they appear only for `connect_and_introduce`.

- [ ] **Step 3: Add the gating + helper functions**

In `public/js/app.js`, add these functions and expose them on `window` (the file is an ES module — inline `onchange`/`oninput` handlers need `window.fn`):
```javascript
function toggleFollowUpFields() {
  const on = document.getElementById('follow-up-toggle')?.checked;
  const box = document.getElementById('follow-up-fields');
  if (box) box.style.display = on ? '' : 'none';
}
window.toggleFollowUpFields = toggleFollowUpFields;

// Lock auto-accept until a primary URL is present.
function refreshAutoAcceptGate() {
  const url = (document.getElementById('primary-person-url')?.value || '').trim();
  const toggle = document.getElementById('auto-accept-toggle');
  const gate = document.getElementById('auto-accept-gate');
  const hasUrl = /linkedin\.com\/in\//i.test(url);
  if (toggle) {
    toggle.disabled = !hasUrl;
    if (!hasUrl) toggle.checked = false;
  }
  if (gate) gate.style.display = hasUrl ? 'none' : '';
}
window.refreshAutoAcceptGate = refreshAutoAcceptGate;
```
Then call `refreshAutoAcceptGate()` inside the existing `savePrimaryPersonFields()` (so typing the URL unlocks the toggle live) and once when the CC+IC section is shown.

- [ ] **Step 4: Read the new fields into the templates payload**

In `public/js/app.js`, in EACH templates-assembly block that already sets `primaryUrl` (the start payload near `:3503`, and any re-run/preset builders that include `primaryUrl` — `:209`, `:3520`, `:5646`, `:5680` style), add adjacent:
```javascript
    autoAcceptPrimary: _isIntroFlow ? !!document.getElementById('auto-accept-toggle')?.checked : false,
    followUpEnabled: _isIntroFlow ? !!document.getElementById('follow-up-toggle')?.checked : false,
    followUpBody: _isIntroFlow ? (document.getElementById('follow-up-body')?.value || '') : '',
    followUpDelayMinutes: _isIntroFlow ? (Number(document.getElementById('follow-up-delay')?.value) || 10) : 10,
    followUpSender: _isIntroFlow ? (document.getElementById('follow-up-sender')?.value || 'local-browser') : 'local-browser',
```
(Use the same `_isIntroFlow`/`_isIc` guard variable already present in that block. For blocks that read from a saved `tpl`/`sched` object instead of the DOM — e.g. re-run — read the fields off that object: `t.autoAcceptPrimary`, etc.)

- [ ] **Step 5: Restore saved values when a preset/last-run loads**

In `public/js/app.js`, where saved templates populate the DOM (the `setV('primary-person-url', ...)` block near `:6976`–`:6979`), add:
```javascript
  if (document.getElementById('auto-accept-toggle')) document.getElementById('auto-accept-toggle').checked = !!t.autoAcceptPrimary;
  if (document.getElementById('follow-up-toggle')) document.getElementById('follow-up-toggle').checked = !!t.followUpEnabled;
  setV('follow-up-body', t.followUpBody || '');
  if (t.followUpDelayMinutes) setV('follow-up-delay', t.followUpDelayMinutes);
  if (t.followUpSender) setV('follow-up-sender', t.followUpSender);
  if (typeof toggleFollowUpFields === 'function') toggleFollowUpFields();
  if (typeof refreshAutoAcceptGate === 'function') refreshAutoAcceptGate();
```

- [ ] **Step 6: Add the small CSS shims (only if missing)**

In `public/css/style.css`, add (matching the Bugatti tokens — gold only as a small NEW tag, hairlines, dark/light aware):
```css
.intro-config-newtag{display:inline-block;font:10px var(--display);letter-spacing:.12em;color:#0a0a0a;background:var(--gold);border-radius:9999px;padding:2px 8px;vertical-align:middle;margin-left:6px;}
.intro-config-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:4px 0 8px;}
.intro-config-toggle-key{font-size:14px;}
.intro-config-gate{display:flex;gap:8px;align-items:flex-start;margin:6px 0 8px;padding:9px 11px;border:1px dashed var(--gold);border-radius:10px;background:var(--gold-tint-bg);font-size:12px;line-height:1.5;}
.intro-config-num{width:64px;border:1px solid var(--hairline);border-radius:8px;padding:7px;text-align:center;font-family:var(--mono);background:var(--card-bg);color:var(--ink);}
```
(Skip any selector that already exists — reuse it instead.)

- [ ] **Step 7: Manual verification**

Run (auto-relaunch per operator rule):
```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```
In the app: select **Connect + Introduce Back**. Verify:
- The two new cards appear only in CC+IC.
- The auto-accept toggle is locked + shows the gate message until a valid `/in/` URL is in the primary URL field; typing one unlocks it live.
- Turning the follow-up toggle on reveals the message + delay + sender row.
- Reloading a saved preset restores all five values.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat: CC+IC config UI for auto-accept + automated first follow-up"
```

---

## Task 11: Version relaunch + end-to-end manual checklist + finish branch

**Files:**
- Modify: `package.json` (patch bump for the verification build)

- [ ] **Step 1: Patch-bump for the verification build**

In `package.json`, bump `2.91.0` → `2.91.1` (so the running UI shows the new build per the operator rule).

- [ ] **Step 2: Relaunch**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 3: Run the whole test suite once more**

Run: `node --test tests/*.test.js`
Expected: all pass.

- [ ] **Step 4: Manual E2E (operator-run, against a test sheet + a non-primary test account)**

Verify on a small CC+IC run with auto-accept ON, follow-up ON (you), delay 1 min:
- An account not connected to the primary sends the connect → log shows `Auto-accept queued`.
- After the send loop ends (idle gap), the local browser opens, accepts only that account's invite, closes (log: `accepted` then local browser closed). No second browser ever opens during a send.
- On the next check the held intro fires; ~1 min later, in an idle gap, the follow-up posts in the same group thread (log: `Follow-up sent`).
- Switch follow-up sender to **the campaign account** and confirm the runner opens that account (not the local browser) for the follow-up.
- Confirm `data/primary-tasks.json` tasks end as `done`/`skipped` and none are left `in_progress`.

- [ ] **Step 5: Commit + push the branch**

```bash
git add package.json
git commit -m "chore: bump to 2.91.1 for primary-side automation verification build"
git push -u origin primary-side-automation-2.91
```
(Use the `ortusclub` gh account for any release/PR — the personal account is read-only.)

- [ ] **Step 6: Finish the branch**

Use the `superpowers:finishing-a-development-branch` workflow to fast-forward merge to `main` after the manual E2E passes.

---

## Self-Review notes (author)

- **Spec coverage:** queue (Task 1), template fields (Task 2), accept primitive + matching (Task 3), follow-up primitive (Task 4), follow-up enqueue all-paths (Task 5), accept enqueue (Task 6), safe-window runner + semaphore gate (Task 7), sweeps→semaphore + post-campaign config (Task 8), boot (Task 9), config UI sketch-D (Task 10), live-log beats (emitted from Tasks 5/6/7 `log()` calls), version/relaunch/E2E (Tasks 0/11). SOO sync intentionally absent (separate spec).
- **Off-limits respected:** `actions.js`/`outreach.js` only imported (`sendConnectionRequest` via the existing `primary-connection.js`); all new DOM in `accept-invitation.js`/`thread-message.js`.
- **Reuse over duplication:** `browser-semaphore.js` (no new lock), `matchPrimaryCandidate`/`normalizeName`, `personalizeTemplate`, `extractSheetId`, `appendCampaignLog`.
- **Type consistency:** task field names (`campaignProfileId`, `sender`, `threadUrl`, `account.{name,profileUrl}`, `dueAt`, `attempts`) are identical across builders, selectors, runner, and tests. Template field names (`autoAcceptPrimary`, `followUpEnabled`, `followUpBody`, `followUpDelayMinutes`, `followUpSender`) are identical across `normalizeTemplates`, UI payload, schedule entry, and sweep pass-through.
