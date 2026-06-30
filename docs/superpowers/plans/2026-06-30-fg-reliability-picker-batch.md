# FG Reliability & Picker Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Follower Growth Team Launch report logged-out accounts honestly, stop wasting invite slots on people who already follow the page (persisting them), show a target count that decrements, and let the operator refresh SoO and hide non-Ortus accounts.

**Architecture:** Five contained changes across the invite engine (`src/linkedin/follower-invite.js`), the sequential orchestrator (`src/connections/fg-team-launch.js`), the target/roster builder (`src/connections/search-service.js`), the team-launch endpoint wiring (`server.js`), and the `fgtl*` picker UI (`public/js/app.js` + `public/index.html`). Every engine path stays soft-skip and unit-testable behind the existing `deps` seams.

**Tech Stack:** Node ≥22, Express 4, vanilla JS frontend (no bundler), `node --test`, GoLogin + puppeteer-core (headed).

## Global Constraints

- Node ≥22, Express 4, vanilla JS frontend (no bundler).
- Test framework: `node --test`. Pure-helper unit tests preferred; UI changes are manual-verify.
- **Off-limits files (do not modify):** `src/linkedin/outreach.js`, `src/linkedin/actions.js`.
- Never `git add data/monitoring-campaign.json`.
- Bump `package.json` patch version before relaunching `dev:app`; auto-relaunch after commits touching runtime code.
- All engine paths stay **soft-skip** — one account failing must never abort the rest of the batch. Write-backs stay best-effort.
- SoO non-Ortus filter (R5) **fails open**: when SoO is unreachable/empty, show ALL accounts unfiltered.
- "Is Ortus" is decided by the SoO **Company** column equal to `The Ortus Club` (case-insensitive); blank/unknown company ⇒ treated as Ortus (optimistic), matching existing `fgtlEligibility`.
- Already-follows persistence reuses the **same record store** as invited IDs (queue row + `markFgInvited`); the modal-observed credit write-back (`observeFgCredits`) keeps the real budget correct.

---

### Task 1: Logout detection in the invite engine

**Files:**
- Modify: `src/linkedin/follower-invite.js` (add `isLoggedOutUrl`, `LoggedOutError`; URL check in `openInviteModal` around lines 109–126)
- Test: `tests/linkedin/follower-invite.test.js`

**Interfaces:**
- Produces: `isLoggedOutUrl(url: string): boolean` (pure, exported); `class LoggedOutError extends Error { softSkip = true; loggedOut = true }` (exported). `openInviteModal` throws `LoggedOutError` when, immediately after `page.goto`, `page.url()` matches a login/authwall URL.

- [ ] **Step 1: Write the failing test**

Add to `tests/linkedin/follower-invite.test.js`:

```js
import { isLoggedOutUrl } from '../../src/linkedin/follower-invite.js';

test('isLoggedOutUrl flags login / authwall / checkpoint redirects', () => {
  assert.equal(isLoggedOutUrl('https://www.linkedin.com/login'), true);
  assert.equal(isLoggedOutUrl('https://www.linkedin.com/authwall?trk=x'), true);
  assert.equal(isLoggedOutUrl('https://www.linkedin.com/checkpoint/lg/login-submit'), true);
  assert.equal(isLoggedOutUrl('https://www.linkedin.com/uas/login?goback='), true);
  assert.equal(isLoggedOutUrl('https://www.linkedin.com/company/the-ortus-club/admin/'), false);
  assert.equal(isLoggedOutUrl(''), false);
  assert.equal(isLoggedOutUrl(null), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/linkedin/follower-invite.test.js`
Expected: FAIL — `isLoggedOutUrl` is not exported / not a function.

- [ ] **Step 3: Add `isLoggedOutUrl` and `LoggedOutError`**

In `src/linkedin/follower-invite.js`, after the `InviteModalUnavailableError` class (ends line 107), add:

```js
// LinkedIn bounces a logged-out session to one of these paths instead of the
// invite page. Detected from page.url() right after goto so we skip in ms instead
// of waiting out the 2-min modal timeout, and report it distinctly (re-login needed).
const LOGGED_OUT_RE = /linkedin\.com\/(login|authwall|checkpoint|uas\/login)/i;
export function isLoggedOutUrl(url) {
  return LOGGED_OUT_RE.test(String(url || ''));
}

export class LoggedOutError extends Error {
  constructor(message) { super(message); this.name = 'LoggedOutError'; this.softSkip = true; this.loggedOut = true; }
}
```

- [ ] **Step 4: Add the URL check in `openInviteModal`**

In `openInviteModal`, immediately after the `page.goto(...)` line (currently line 111) and before the `try { await page.waitForSelector(SEL.modal ...` block, insert:

```js
  // Logged-out session redirects to a login/authwall URL — detect it now and skip
  // fast with a distinct error instead of waiting 2 min for a modal that won't mount.
  const landed = await page.url();
  if (isLoggedOutUrl(landed)) {
    throw new LoggedOutError('account is logged out of LinkedIn — re-login needed before it can send follow invites');
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/linkedin/follower-invite.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/linkedin/follower-invite.js tests/linkedin/follower-invite.test.js
git commit -m "feat(fg): detect logged-out session in openInviteModal (fast distinct skip)"
```

---

### Task 2: Report logged-out accounts in the Team Launch orchestrator

**Files:**
- Modify: `src/connections/fg-team-launch.js` (the `catch (err)` block, lines 56–68)
- Test: `tests/fg-team-launch.test.js`

**Interfaces:**
- Consumes: `LoggedOutError` (a thrown error with `err.loggedOut === true`) propagating from `deps.launch`/`deps.send`.
- Produces: on a logged-out error, `slot.status = 'skipped'`, `slot.reason = 'logged out'`, `slot.loggedOut = true`, `status.skipped` incremented, and a `🔒 [account] Logged out — needs re-login` log line.

- [ ] **Step 1: Write the failing test**

Add to `tests/fg-team-launch.test.js`:

```js
test('runTeamLaunch labels a logged-out account distinctly', async () => {
  const pairs = [{ account: 'a@ortusclub.com', operator: 'a@ortusclub.com', profileId: 'p1' }];
  const status = makeInitialStatus(pairs);
  const deps = {
    buildTargets: () => ({ rows: [['N', '', 'm1']], count: 1, reason: '' }),
    launch: async () => { const e = new Error('logged out'); e.loggedOut = true; e.softSkip = true; throw e; },
    send: async () => ({ invited: [], skipped: [] }),
    record: async () => {},
    log: () => {},
    now: () => '2026-06-30T00:00:00Z',
  };
  await runTeamLaunch(pairs, { keywords: [], month: '2026-06', getAbort: () => false }, deps, status);
  assert.equal(status.perAccount[0].status, 'skipped');
  assert.equal(status.perAccount[0].reason, 'logged out');
  assert.equal(status.perAccount[0].loggedOut, true);
  assert.equal(status.skipped, 1);
  assert.ok(status.logs.some((l) => /Logged out/.test(l)));
});
```

(Reuse the existing `import { runTeamLaunch, makeInitialStatus } from '../src/connections/fg-team-launch.js';` already at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-team-launch.test.js`
Expected: FAIL — `loggedOut` flag and `reason === 'logged out'` not set (falls into the generic soft-skip branch).

- [ ] **Step 3: Handle the logged-out error in the catch block**

In `src/connections/fg-team-launch.js`, replace the `else` branch inside `catch (err)` (currently lines 62–68) with a logged-out-aware version:

```js
        } else if (err.loggedOut) {
          slot.status = 'skipped'; slot.reason = 'logged out'; slot.loggedOut = true; status.skipped++;
          stamp(`🔒 [${pair.account}] Logged out — needs re-login`);
        } else {
          // A soft-skip (e.g. the invite modal didn't open in time) is expected, not
          // a failure — label it ⊘ so it reads clearly vs a real ✗ error.
          slot.status = 'skipped'; slot.reason = err.message; status.skipped++;
          slot.softSkip = !!err.softSkip;
          stamp(err.softSkip ? `⊘ [${pair.account}] Skipped — ${err.message}` : `✗ [${pair.account}] Error — ${err.message}`);
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-team-launch.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connections/fg-team-launch.js tests/fg-team-launch.test.js
git commit -m "feat(fg): report logged-out accounts distinctly in team launch"
```

---

### Task 3: Classify already-follows in the invite engine

**Files:**
- Modify: `src/linkedin/follower-invite.js` (add `classifySkip`; change `selectPerson` return shape lines 165–189; collect `alreadyFollowing` in `runFollowerInvites` lines 208–237)
- Test: `tests/linkedin/follower-invite-run.test.js`, `tests/linkedin/follower-invite.test.js`

**Interfaces:**
- Produces:
  - `classifySkip(results, person): 'already-follows' | 'no-match'` (pure, exported) — `'already-follows'` when a name-matched result exists but is not invitable (`canInvite === false`); else `'no-match'`.
  - `selectPerson(...)` now returns `{ selected: boolean, reason: 'ok' | 'already-follows' | 'no-match' }`.
  - `runFollowerInvites(...)` return object gains `alreadyFollowing: string[]` (member IDs whose skip reason was `already-follows`). These IDs are NOT in `invited` and ARE in `skipped` (backward compatible).
- Consumes: existing `pickInviteResult`, `firstLastMatches`, `scrapeResults`. `runFollowerInvites` tolerates a boolean OR `{selected,reason}` from `deps.selectPerson` (existing tests inject booleans).

- [ ] **Step 1: Write the failing tests**

Add to `tests/linkedin/follower-invite.test.js`:

```js
import { classifySkip } from '../../src/linkedin/follower-invite.js';

test('classifySkip = already-follows when name matches but not invitable', () => {
  const person = { name: 'Mara Lee' };
  assert.equal(classifySkip([{ name: 'Mara Lee', headline: '', canInvite: false }], person), 'already-follows');
  assert.equal(classifySkip([{ name: 'Someone Else', headline: '', canInvite: false }], person), 'no-match');
  assert.equal(classifySkip([], person), 'no-match');
});
```

Add to `tests/linkedin/follower-invite-run.test.js`:

```js
test('runFollowerInvites collects already-follows IDs separately', async () => {
  const queued = [
    { name: 'Mara Lee', memberId: '1' },   // selected
    { name: 'Dan Roe', memberId: '2' },    // already follows
  ];
  const deps = {
    readCredits: async () => 5,
    selectPerson: async (_page, person) =>
      person.name === 'Mara Lee' ? { selected: true, reason: 'ok' } : { selected: false, reason: 'already-follows' },
    clickInvite: async () => true,
    sleep: async () => {},
  };
  const res = await runFollowerInvites({ page: {}, queued, log: () => {}, shouldAbort: () => false, deps });
  assert.deepEqual(res.invited, ['1']);
  assert.deepEqual(res.alreadyFollowing, ['2']);
  assert.ok(res.skipped.includes('2'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/linkedin/follower-invite.test.js tests/linkedin/follower-invite-run.test.js`
Expected: FAIL — `classifySkip` not exported; `res.alreadyFollowing` undefined.

- [ ] **Step 3: Add `classifySkip`**

In `src/linkedin/follower-invite.js`, after `pickInviteResult` (ends line 62), add:

```js
// Why was a queued person skipped? 'already-follows' when a name-matched result
// exists but LinkedIn won't let us invite them (canInvite=false → already a
// follower/invitee — they cost no credit and should be remembered & not re-tried);
// otherwise 'no-match' (no invitable name match at all).
export function classifySkip(results, person) {
  const target = ((person && person.name) || '').trim().toLowerCase();
  const nameHit = (results || []).some((r) =>
    (r.name || '').trim().toLowerCase() === target || firstLastMatches(r.name, person.name));
  return nameHit ? 'already-follows' : 'no-match';
}
```

- [ ] **Step 4: Change `selectPerson` to return `{selected, reason}`**

In `selectPerson`, update the early-return and the no-choice/return paths so it always returns a `{ selected, reason }` object:

Replace the `if (!hasSearch) { ... return false; }` line with:

```js
  if (!hasSearch) { log(`skip "${person.name}" — search box not present`); return { selected: false, reason: 'no-match' }; }
```

Replace the `if (!choice) { log(...); return false; }` line with:

```js
  if (!choice) {
    const reason = classifySkip(results, person);
    log(`skip "${person.name}" (${reason}) — scraped ${JSON.stringify(results.slice(0, 2))}`);
    return { selected: false, reason };
  }
```

Replace the final `return clicked;` line with:

```js
  return { selected: clicked, reason: clicked ? 'ok' : 'no-match' };
```

- [ ] **Step 5: Collect `alreadyFollowing` in `runFollowerInvites`**

In `runFollowerInvites`, replace the loop body and return to normalize the result and track already-follows. Replace lines 225–236 (`const invited = [], skipped = [];` through the `return {...}`) with:

```js
  const invited = [], skipped = [], alreadyFollowing = [];
  for (const person of queued) {
    if (shouldAbort()) { log('aborted'); break; }
    if (invited.length >= creditsBefore) { log('credit cap reached'); break; }
    const r = await d.selectPerson(page, person, { log });
    const selected = (r && typeof r === 'object') ? !!r.selected : !!r;
    const reason = (r && typeof r === 'object') ? r.reason : '';
    if (selected) {
      invited.push(person.memberId);
    } else {
      skipped.push(person.memberId);
      if (reason === 'already-follows') alreadyFollowing.push(person.memberId);
    }
    await d.sleep();
  }
  let sent = false;
  if (invited.length) sent = await d.clickInvite(page, { log });
  const creditsAfter = sent ? Math.max(0, creditsBefore - invited.length) : creditsBefore;
  return { invited: sent ? invited : [], skipped: sent ? skipped : skipped.concat(invited), alreadyFollowing, creditsBefore, creditsAfter, allowance, refill, sent };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/linkedin/follower-invite.test.js tests/linkedin/follower-invite-run.test.js`
Expected: PASS (including the pre-existing run tests — they inject boolean `selectPerson` which the normalizer still handles).

- [ ] **Step 7: Commit**

```bash
git add src/linkedin/follower-invite.js tests/linkedin/follower-invite.test.js tests/linkedin/follower-invite-run.test.js
git commit -m "feat(fg): classify already-follows skips and surface alreadyFollowing IDs"
```

---

### Task 4: Persist already-follows so they're skipped forever

**Files:**
- Modify: `src/connections/fg-team-launch.js` (`runTeamLaunch` send block, lines 42–55)
- Modify: `server.js` (team-launch `record` dep, lines 1599–1617)
- Test: `tests/fg-team-launch.test.js`

**Interfaces:**
- Consumes: `out.alreadyFollowing` from `deps.send` (Task 3).
- Produces: `runTeamLaunch` passes `alreadyFollowingIds` to `deps.record({ rows, invitedIds, alreadyFollowingIds, account, operator })`. The server `record` dep marks `invitedIds.concat(alreadyFollowingIds)` into the same FG store (queue rows + `markFgInvited`), so `buildFgTargets`' `alreadyInvited` dedupe excludes already-follows on subsequent runs.

- [ ] **Step 1: Write the failing test**

Add to `tests/fg-team-launch.test.js`:

```js
test('runTeamLaunch forwards already-following IDs to record', async () => {
  const pairs = [{ account: 'a@ortusclub.com', operator: 'a@ortusclub.com', profileId: 'p1' }];
  const status = makeInitialStatus(pairs);
  let recorded = null;
  const deps = {
    buildTargets: () => ({ rows: [['N', '', 'm1'], ['M', '', 'm2']], count: 2, reason: '' }),
    launch: async () => ({ page: {}, close: async () => {} }),
    send: async () => ({ invited: ['m1'], skipped: ['m2'], alreadyFollowing: ['m2'], creditsAfter: 4 }),
    record: async (arg) => { recorded = arg; },
    log: () => {},
    now: () => '2026-06-30T00:00:00Z',
  };
  await runTeamLaunch(pairs, { keywords: [], month: '2026-06', getAbort: () => false }, deps, status);
  assert.deepEqual(recorded.invitedIds, ['m1']);
  assert.deepEqual(recorded.alreadyFollowingIds, ['m2']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-team-launch.test.js`
Expected: FAIL — `recorded.alreadyFollowingIds` is `undefined` (not forwarded).

- [ ] **Step 3: Forward already-follows from the orchestrator**

In `src/connections/fg-team-launch.js`, inside the `try` after `const out = await deps.send(...)` (line 42), update the invited handling. Replace lines 43–44:

```js
        const invitedIds = out.invited || [];
        if (invitedIds.length) await deps.record({ rows, invitedIds, account: pair.account, operator: pair.operator, month: ctx.month });
```

with:

```js
        const invitedIds = out.invited || [];
        const alreadyFollowingIds = out.alreadyFollowing || [];
        // Persist invited AND already-follows in the same store so the next build
        // dedupes both out — already-follows cost no credit and must never re-fill a slot.
        if (invitedIds.length || alreadyFollowingIds.length) {
          await deps.record({ rows, invitedIds, alreadyFollowingIds, account: pair.account, operator: pair.operator, month: ctx.month });
        }
        if (alreadyFollowingIds.length) stamp(`[${pair.account}] already follows the page — ${alreadyFollowingIds.length} remembered & skipped`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-team-launch.test.js`
Expected: PASS.

- [ ] **Step 5: Update the server `record` dep to persist both sets**

In `server.js`, in the team-launch `record` dep (lines 1599–1617), persist the union of invited + already-follows. Replace the body of `record: async ({ rows, invitedIds, account, operator }) => {` with one that accepts `alreadyFollowingIds`:

```js
        record: async ({ rows, invitedIds, alreadyFollowingIds = [], account, operator }) => {
          // Already-follows go into the SAME store as invited so the next build's
          // alreadyInvited dedupe removes them; the observeCredits write-back keeps
          // the real budget correct (these consumed no credit).
          const persistIds = [...new Set([...(invitedIds || []), ...alreadyFollowingIds].map(String))];
          const set = new Set(persistIds);
          const persistRows = rows.filter((r) => set.has(String(r[2])));
          if (persistRows.length) {
            await queueFgInvites(persistRows);
            try {
              await markFgInvited({ memberIds: persistIds, account, operator, month });
            } catch (e1) {
              try {
                await markFgInvited({ memberIds: persistIds, account, operator, month }); // retry (idempotent)
              } catch (e2) {
                const warn = `[${new Date().toISOString()}] ⚠ STRANDED: ${persistIds.length} invite(s)/follow(s) for ${account} were queued but NOT marked Invited — flip them manually in the FG sheet (${e2.message})`;
                try { _fgTeam.logs.push(warn); if (_fgTeam.logs.length > 200) _fgTeam.logs.shift(); } catch (_) {}
                try { campaignLog(`[FG-team] ${warn}`); } catch (_) {}
              }
            }
          }
          _fgTeamSnap = await getFgState(); // refresh so the next account dedups against these
        },
```

- [ ] **Step 6: Verify server.js parses**

Run: `node --check server.js`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add src/connections/fg-team-launch.js server.js tests/fg-team-launch.test.js
git commit -m "feat(fg): persist already-follows in the invited store (never re-tried)"
```

---

### Task 5: Decrement the per-colleague match count by already-invited/follows

**Files:**
- Modify: `src/connections/search-service.js` (`listFgColleaguesMatched`, lines 249–266)
- Modify: `server.js` (`/api/fg/colleagues`, lines 1410–1414)
- Test: `tests/fg-colleagues.test.js`

**Interfaces:**
- Produces: `listFgColleaguesMatched(keywords, opts)` accepts `opts.alreadyInvited: string[]` (member-id-or-URL keys). The returned `matched` per colleague EXCLUDES contacts whose `inviteKey` is in that set; `total` stays the raw non-DNC count.
- Consumes: `inviteKey` (already imported in search-service.js line 12). The `/api/fg/colleagues` route builds `alreadyInvited` from `getFgState().invites` (same expression used at server.js:1434 and :1578) and passes it.

- [ ] **Step 1: Write the failing test**

Add to `tests/fg-colleagues.test.js`:

```js
test('listFgColleaguesMatched subtracts already-invited from matched (not total)', () => {
  __setFgColleaguesFixtures({
    annotated: [
      { contact: { firstname: 'A', jobtitle: 'Head of Marketing', linkedin_membership_id: 'm1' }, warmVia: ['bea@ortusclub.com'], dnc: false },
      { contact: { firstname: 'B', jobtitle: 'Brand Lead', linkedin_membership_id: 'm2' }, warmVia: ['bea@ortusclub.com'], dnc: false },
    ],
    colleagues: { 'bea@ortusclub.com': { name: 'Beatrice' } },
  });
  const out = listFgColleaguesMatched(['marketing', 'brand'], { alreadyInvited: ['m1'] });
  assert.deepEqual(out, [
    { email: 'bea@ortusclub.com', name: 'Beatrice', total: 2, matched: 1 }, // m1 already invited → excluded from matched
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-colleagues.test.js`
Expected: FAIL — `matched` is `2` (the option is ignored).

- [ ] **Step 3: Implement the exclusion**

In `src/connections/search-service.js`, change the signature and matched-count of `listFgColleaguesMatched`. Replace its header line:

```js
export function listFgColleaguesMatched(keywords = [], { dir, cachePath } = {}) {
```

with:

```js
export function listFgColleaguesMatched(keywords = [], { dir, cachePath, alreadyInvited = [] } = {}) {
```

Then, inside it, after `const norm = normCriteria(...)`, add:

```js
  const invitedKeys = new Set((alreadyInvited || []).map(String));
```

And in the loop, change the matched increment so it skips already-invited contacts. Replace:

```js
    const isMatch = matchesCriteria(r.contact, norm);
    for (const email of (r.warmVia || [])) {
      total.set(email, (total.get(email) || 0) + 1);
      if (isMatch) matched.set(email, (matched.get(email) || 0) + 1);
    }
```

with:

```js
    const isMatch = matchesCriteria(r.contact, norm);
    const alreadyDone = invitedKeys.has(inviteKey(r.contact));
    for (const email of (r.warmVia || [])) {
      total.set(email, (total.get(email) || 0) + 1);
      if (isMatch && !alreadyDone) matched.set(email, (matched.get(email) || 0) + 1);
    }
```

- [ ] **Step 4: Wire the route to pass already-invited**

In `server.js`, replace the `/api/fg/colleagues` handler body (lines 1411–1413) so it is async and supplies the invited set:

```js
app.get('/api/fg/colleagues', async (req, res) => {
  try {
    const roles = parseRolesParam(req.query.roles);
    let alreadyInvited = [];
    try {
      const { invites } = await getFgState();
      alreadyInvited = (invites || []).map((r) => String(r['Member ID'] || '') || (r['LinkedIn URL'] || ''));
    } catch (_) { /* FG sheet unreachable — fall back to raw matched counts */ }
    res.json({ colleagues: listFgColleaguesMatched(roles, { alreadyInvited }) });
```

(Keep the existing `} catch (err) { res.status(500)... }` close.)

- [ ] **Step 5: Run tests + parse check**

Run: `node --test tests/fg-colleagues.test.js tests/fg-colleagues-route.test.js && node --check server.js`
Expected: PASS and no parse error. If `fg-colleagues-route.test.js` asserts the old non-invited count shape, update its expectation to pass `alreadyInvited: []` semantics (matched unchanged when nothing invited).

- [ ] **Step 6: Commit**

```bash
git add src/connections/search-service.js server.js tests/fg-colleagues.test.js
git commit -m "feat(fg): per-colleague match count excludes already-invited/follows"
```

---

### Task 6: Picker — hide non-Ortus accounts + SoO refresh button

**Files:**
- Modify: `public/js/app.js` (`fgtlRenderPeople` line 13531; add refresh handler; the team-launch board nav id `nav-follower-growth`)
- Modify: `public/index.html` (add a refresh button near the FG people list header)
- Modify: `package.json` (version bump)
- Test: manual (UI). Pure predicate covered by `fgtlEligibility` already.

**Interfaces:**
- Consumes: `fgtlEligibility(email)` (returns `{ eligible, company }`), `loadSoOStatus()`, `sooData`, `fgtlRenderPeople()`.
- Produces: `fgtlRenderPeople` filters out non-eligible (non-Ortus) people **only when SoO data is present** (fail-open: when `sooData` is empty/unloaded, show all). A `#fgtl-soo-refresh` button re-runs `loadSoOStatus()` then `fgtlRenderPeople()`.

- [ ] **Step 1: Add the fail-open non-Ortus filter to `fgtlRenderPeople`**

In `public/js/app.js`, in `fgtlRenderPeople` (line 13531), change the people source line. Replace:

```js
  const q = (document.getElementById('fgtl-search')?.value || '').toLowerCase();
  el.innerHTML = fgtlPeople.filter((p) => p.email.toLowerCase().includes(q)).map((p) => {
```

with:

```js
  const q = (document.getElementById('fgtl-search')?.value || '').toLowerCase();
  // Hide non-Ortus accounts (SoO Company ≠ The Ortus Club). Fail-open: if SoO data
  // hasn't loaded (empty), show everyone so a transient SoO outage doesn't block launching.
  const sooReady = typeof sooData !== 'undefined' && sooData && Object.keys(sooData).length > 0;
  el.innerHTML = fgtlPeople
    .filter((p) => p.email.toLowerCase().includes(q))
    .filter((p) => !sooReady || fgtlEligibility(p.email).eligible)
    .map((p) => {
```

- [ ] **Step 2: Add the refresh button to the markup**

In `public/index.html`, find the FG people list header (the element containing `id="fgtl-refresh-spin"` / the people search row inside the `nav-follower-growth` section) and add, next to the existing spinner:

```html
<button type="button" id="fgtl-soo-refresh" class="fgtl-refresh-btn" title="Reload account status from SoO">↻ Refresh status</button>
```

(If no obvious header container exists, place it immediately before the `#fgtl-people` element.)

- [ ] **Step 3: Wire the refresh handler**

In `public/js/app.js`, in `fgtlBindBoard` (the `root.addEventListener('click', ...)` at line 13652), add a branch alongside the others:

```js
    if (e.target.id === 'fgtl-soo-refresh') {
      const btn = e.target; const prev = btn.textContent; btn.disabled = true; btn.textContent = '↻ Refreshing…';
      loadSoOStatus().then(() => { fgtlRenderPeople(); }).finally(() => { btn.disabled = false; btn.textContent = prev; });
      return;
    }
```

- [ ] **Step 4: Bump version**

In `package.json`, bump the patch version (e.g. `2.122.x` → next patch). Use the current value + 1 patch.

- [ ] **Step 5: Syntax check + relaunch**

```bash
node --check public/js/app.js && node --check server.js
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Manual verify (Cmd+R in the Electron shell, open Follower Growth → Team Launch):
- A colleague whose SoO Company is a client company no longer appears in the people list.
- With SoO unreachable (error pill showing), ALL colleagues appear (fail-open).
- Clicking **↻ Refresh status** re-pulls SoO and updates the list/pills without a restart.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js public/index.html package.json
git commit -m "feat(fg): hide non-Ortus accounts + SoO refresh button on the team picker"
```

---

### Task 7: Full suite + branch verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `node --test`
Expected: all tests pass, 0 fail. Investigate and fix any regression before finishing.

- [ ] **Step 2: Confirm no off-limits or forbidden files staged**

Run: `git log --oneline main..HEAD` and `git diff --name-only main..HEAD`
Expected: no `src/linkedin/outreach.js`, no `src/linkedin/actions.js`, no `data/monitoring-campaign.json`.

---

## Self-Review

**Spec coverage:**
- R1 (logout detect + report) → Task 1 (engine) + Task 2 (orchestrator report). ✅
- R2 (matches reflect eligible) → Task 5. ✅
- R3 (already-follows skip/drop/persist) → Task 3 (classify) + Task 4 (persist same store). The "drop from list / don't count" follows automatically: once persisted, Task 5's count excludes them and `buildFgTargets`' existing `alreadyInvited` dedupe removes them from the queue. ✅
- R4 (SoO refresh button) → Task 6. ✅
- R5 (hide non-Ortus, fail-open) → Task 6. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `selectPerson` returns `{selected, reason}` (Task 3) and `runFollowerInvites` normalizes boolean-or-object — consistent with `deps.selectPerson` booleans in existing tests. `record({..., alreadyFollowingIds})` defined in Task 4 orchestrator and consumed in Task 4 server dep (`alreadyFollowingIds = []` default). `listFgColleaguesMatched(keywords, {alreadyInvited})` defined in Task 5 and called with `{alreadyInvited}` in the same task. `isLoggedOutUrl`, `LoggedOutError`, `classifySkip` exported in Tasks 1/3 and consumed in Tasks 2/4. ✅

**Note for executor:** `fg-colleagues-route.test.js` already exists and may assert the colleagues route output; if it breaks after Task 5's async change, update its expectation (the route now also fetches FG state — fixtures/mocks may need an `alreadyInvited`-free path that returns unchanged counts).
