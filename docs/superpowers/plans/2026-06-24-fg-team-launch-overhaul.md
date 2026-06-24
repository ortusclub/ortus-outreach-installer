# FG Team Launch board overhaul (variant A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded Team Launch board with the variant-A "Browse + Launch cart" layout that surfaces matched-connections-per-person, invites-left, a searchable GoLogin picker, and the real `vj-card` live log.

**Architecture:** One new service helper computes matched-vs-total connections per colleague for the current role keywords (single pass over the memoized annotated DB). The existing `/api/fg/colleagues` route gains an additive `roles` param. The `#nav-follower-growth` panel is rebuilt to the cart layout; the chosen sketch `public/sketches/fg-overhaul-A-cart.html` is the source of truth for rendering. The sequential engine, `/team-launch/*` routes, write-back, and live-card poll from the prior build are reused unchanged.

**Tech Stack:** Node ≥22, Express 4, vanilla JS frontend (no bundler), `node --test`.

## Global Constraints

- Test framework is `node --test` ONLY — no Jest/Vitest.
- Never modify `src/linkedin/outreach.js` or `src/linkedin/actions.js`.
- Never `git add data/monitoring-campaign.json`.
- Auto-send defaults OFF; do NOT trigger any real LinkedIn send during verification.
- Bump `package.json` version (patch) before relaunching `npm run dev:app`.
- Role chips use the `.chip-tag` class (not `.chip`).
- Auto-pair convention: GoLogin profile `name` === colleague email (case-insensitive).
- Matched-count semantics: empty/absent keywords ⇒ `matched === total` (no role filter).
- `GET /api/fg/colleagues` MUST stay backward compatible — no `roles` param returns the roster as before.
- Branch: `fg-team-launch-2116` (continue on it).

---

### Task 1: `listFgColleaguesMatched` service helper

**Files:**
- Modify: `src/connections/search-service.js` (add export near `listFgColleagues`, ~line 238)
- Test: `tests/fg-colleagues.test.js` (add cases)

**Interfaces:**
- Consumes: `getAnnotated(dir, cachePath)`, `getColleagues()`, `matchesCriteria` (imported from `./match.js`), `normCriteria`, the existing `_fgColleaguesFixtures` test seam set by `__setFgColleaguesFixtures`.
- Produces: `listFgColleaguesMatched(keywords = [], { dir, cachePath } = {}) → [{ email, name, total, matched }]` sorted by `name`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/fg-colleagues.test.js`:

```js
import { __setFgColleaguesFixtures, listFgColleagues, listFgColleaguesMatched } from '../src/connections/search-service.js';

test('listFgColleaguesMatched counts matched (role keywords) and total per owner', () => {
  __setFgColleaguesFixtures({
    annotated: [
      { contact: { firstname: 'A', jobtitle: 'Head of Marketing' }, warmVia: ['bea@ortusclub.com'], dnc: false },
      { contact: { firstname: 'B', jobtitle: 'Engineer' },          warmVia: ['bea@ortusclub.com', 'sam@ortusclub.com'], dnc: false },
      { contact: { firstname: 'C', jobtitle: 'Brand Lead' },        warmVia: ['sam@ortusclub.com'], dnc: false },
      { contact: { firstname: 'D', jobtitle: 'CMO' },               warmVia: ['sam@ortusclub.com'], dnc: true }, // DNC excluded from both
    ],
    colleagues: { 'bea@ortusclub.com': { name: 'Beatrice' }, 'sam@ortusclub.com': { name: 'Sam' } },
  });
  const out = listFgColleaguesMatched(['marketing', 'brand']);
  assert.deepEqual(out, [
    { email: 'bea@ortusclub.com', name: 'Beatrice', total: 2, matched: 1 }, // A matches, B not
    { email: 'sam@ortusclub.com', name: 'Sam', total: 2, matched: 1 },      // C matches, B not, D dnc
  ]);
});

test('listFgColleaguesMatched with no keywords => matched equals total', () => {
  __setFgColleaguesFixtures({
    annotated: [
      { contact: { firstname: 'A', jobtitle: 'Anything' }, warmVia: ['bea@ortusclub.com'], dnc: false },
      { contact: { firstname: 'B', jobtitle: '' },         warmVia: ['bea@ortusclub.com'], dnc: false },
    ],
    colleagues: { 'bea@ortusclub.com': { name: 'Beatrice' } },
  });
  const out = listFgColleaguesMatched([]);
  assert.deepEqual(out, [{ email: 'bea@ortusclub.com', name: 'Beatrice', total: 2, matched: 2 }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/fg-colleagues.test.js`
Expected: FAIL — `listFgColleaguesMatched is not a function`.

- [ ] **Step 3: Implement the helper**

In `src/connections/search-service.js`, immediately after the existing `listFgColleagues` function (after its closing `}` near line 238), add:

```js
// Like listFgColleagues but also counts, per owner, how many of their non-DNC
// connections MATCH the role keywords (jobtitle substring). One pass over the
// memoized annotated DB. Empty keywords => matched === total (matchesCriteria
// returns true when the jobTitles list is empty). Sorted by name.
export function listFgColleaguesMatched(keywords = [], { dir, cachePath } = {}) {
  const annotated = _fgColleaguesFixtures ? _fgColleaguesFixtures.annotated : getAnnotated(dir, cachePath);
  const colleagues = _fgColleaguesFixtures ? _fgColleaguesFixtures.colleagues : getColleagues();
  const norm = normCriteria({ jobTitles: keywords || [] });
  const total = new Map();
  const matched = new Map();
  for (const r of annotated) {
    if (r.dnc) continue;
    const isMatch = matchesCriteria(r.contact, norm);
    for (const email of (r.warmVia || [])) {
      total.set(email, (total.get(email) || 0) + 1);
      if (isMatch) matched.set(email, (matched.get(email) || 0) + 1);
    }
  }
  return [...total.entries()]
    .map(([email, t]) => ({ email, name: colleagues[email]?.name || email, total: t, matched: matched.get(email) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/fg-colleagues.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/connections/search-service.js tests/fg-colleagues.test.js
git commit -m "feat(fg): listFgColleaguesMatched — matched vs total per colleague"
```

---

### Task 2: `roles` param on `GET /api/fg/colleagues`

**Files:**
- Modify: `server.js` — import (line ~74) and the `/api/fg/colleagues` route (~line 1399)
- Test: `tests/fg-colleagues-route.test.js` (create — tests the parse + delegation in isolation)

**Interfaces:**
- Consumes: `listFgColleaguesMatched` from Task 1.
- Produces: `GET /api/fg/colleagues?roles=a,b,c` → `{ colleagues: [{ email, name, total, matched }] }`. No `roles` ⇒ same shape with `matched === total` (full roster, no regression).

- [ ] **Step 1: Write the failing test**

Create `tests/fg-colleagues-route.test.js`. The route logic is a thin wrapper, so we test the pure `parseRoles` helper that Step 3 exports from `server.js` is impractical (server.js boots the app). Instead test the parsing rule as a standalone pure function placed in `search-service.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRolesParam } from '../src/connections/search-service.js';

test('parseRolesParam splits, trims, lowercases, drops empties', () => {
  assert.deepEqual(parseRolesParam('Marketing, Brand ,, growth'), ['marketing', 'brand', 'growth']);
});
test('parseRolesParam returns [] for undefined/empty', () => {
  assert.deepEqual(parseRolesParam(undefined), []);
  assert.deepEqual(parseRolesParam(''), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/fg-colleagues-route.test.js`
Expected: FAIL — `parseRolesParam is not a function`.

- [ ] **Step 3: Implement `parseRolesParam` and wire the route**

In `src/connections/search-service.js`, add near `listFgColleaguesMatched`:

```js
// Parse a comma-separated ?roles= query value into normalized keyword list.
export function parseRolesParam(v) {
  return String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
```

In `server.js`, extend the import at line ~74 to include the two new names:

```js
import { getConnectionsStats, searchConnections, exportConnections, buildLeadRows, buildFgTargets, listOperators, listFgColleagues, listFgColleaguesMatched, parseRolesParam } from './src/connections/search-service.js';
```

Replace the existing route (currently `app.get('/api/fg/colleagues', ...)` at ~line 1399) with:

```js
// Employee roster for the Team Launch board. With ?roles=a,b,c it also returns
// matched (connections whose job title matches the roles) per colleague; without
// it, matched === total (full roster — backward compatible).
app.get('/api/fg/colleagues', (req, res) => {
  try {
    const roles = parseRolesParam(req.query.roles);
    res.json({ colleagues: listFgColleaguesMatched(roles) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/fg-colleagues-route.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Manual route check**

Run the server (`npm run dev:app`), then in another shell (the server requires auth, so a 200 with JSON OR a 401/Not-authenticated both prove the route is wired and not a 404):

Run: `curl -s "http://localhost:3000/api/fg/colleagues?roles=marketing,brand" | head -c 200`
Expected: JSON containing `"matched"` (if a session is active) or an auth message — NOT a 404 / "Cannot GET".

- [ ] **Step 6: Commit**

```bash
git add server.js src/connections/search-service.js tests/fg-colleagues-route.test.js
git commit -m "feat(fg): /api/fg/colleagues?roles= returns matched-per-colleague"
```

---

### Task 3: Rebuild the `#nav-follower-growth` panel markup (variant A)

**Files:**
- Modify: `public/index.html` — the `#nav-follower-growth` section (the Team Launch board: role-chips card, board grid, `vj-card`, dock, DB view block — currently ~lines 1456–1640) and its scoped `<style>` block (~lines 1457–1536)
- Reference (source of truth for layout/markup/classes): `public/sketches/fg-overhaul-A-cart.html`

**Interfaces:**
- Produces these element IDs/classes consumed by Task 4 (keep names EXACT):
  - Role chips: container `#fgtl-chips` with input `#fgtl-chip-input`; presets `#fgtl-presets`; match line `#fgtl-match`.
  - Browse: search `#fgtl-search` (+ clear `#fgtl-search-clear`), list `#fgtl-people` (scrollable, `max-height:520px; overflow-y:auto`).
  - Cart: list `#fgtl-cart`, foot `#fgtl-foot` with `#fgtl-t-people`, `#fgtl-t-inv`, launch button `#fgtl-go`.
  - Live card: REUSE the existing `vj-card` markup already in this section (IDs `#fgtl-card`, `#fgtl-eyebrow`, `#fgtl-bar`, `#fgtl-pct`, `#fgtl-sent`, `#fgtl-total`, `#fgtl-accts`, `#fgtl-inv`, `#fgtl-seq`, `#fgtl-logbody`, `#fgtl-sum-sent`, `#fgtl-sum-skip`, `#fgtl-loghead`, `#fgtl-copy`). Keep it; only ensure it sits after the board grid.
  - DB toggle: button `#fgtl-db-toggle`, body `#fgtl-db-body` (the existing Invites/Budgets/Funnel block moved INSIDE `#fgtl-db-body`, hidden by default).
- Consumes: nothing from later tasks.

- [ ] **Step 1: Replace the board markup**

Open `public/sketches/fg-overhaul-A-cart.html` and copy its structure. In `public/index.html`, within `#nav-follower-growth`, KEEP the `<h2>` heading and the existing `vj-card` (`#fgtl-card …`), and REPLACE the two-zone board (`<div class="board">…</div>` with `#fgtl-emps` / `#fgtl-gls`) and the old `fgtl-dock` with the variant-A markup:

```html
<!-- Step 1 · role chips (unchanged container IDs) -->
<div class="fgtl-roles">
  <div class="fgtl-step-eyebrow">① Which roles to invite — counts update live</div>
  <div class="chips" id="fgtl-chips"><input id="fgtl-chip-input" placeholder="add a role keyword…" autocomplete="off"></div>
  <div class="presets" id="fgtl-presets"><span class="lbl">Quick add</span></div>
  <div class="filter-foot"><span class="hint">Defaults toward marketers. Applies to everyone below.</span><span class="match" id="fgtl-match"></span></div>
</div>

<!-- Step 2 · browse + cart -->
<div class="fgtl-board2">
  <div>
    <div class="fgtl-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
      <input id="fgtl-search" placeholder="Search the team by name or email…" autocomplete="off">
      <button class="clr" id="fgtl-search-clear" title="Clear">×</button>
    </div>
    <div class="fgtl-people" id="fgtl-people"></div>
  </div>
  <div class="fgtl-cart">
    <h3>Your launch list</h3>
    <div id="fgtl-cart"></div>
    <div class="fgtl-cart-foot" id="fgtl-foot" style="display:none">
      <div class="tot"><span>People</span><b id="fgtl-t-people">0</b></div>
      <div class="tot"><span>Invites this run</span><b id="fgtl-t-inv">0</b></div>
      <button class="fgtl-go-btn" id="fgtl-go" disabled>Launch all sequentially</button>
    </div>
  </div>
</div>
```

Then ensure the existing `vj-card` (`#fgtl-card`) follows immediately after `.fgtl-board2`, and wrap the existing Invites/Budgets/Funnel database block in:

```html
<div class="fgtl-dbwrap">
  <button class="fgtl-db-toggle" id="fgtl-db-toggle">▸ View Follower Growth database (invites · budgets · funnel)</button>
  <div class="fgtl-db-body" id="fgtl-db-body" style="display:none">
    <!-- existing Invites/Budgets/Funnel tabs + tables go here unchanged -->
  </div>
</div>
```

- [ ] **Step 2: Replace the scoped CSS**

In the `#nav-follower-growth` `<style>` block, remove the old `.board` / `.emp` / `.fgtl-panel` / `.gl` / `.picker select` rules and add (scoped under `#nav-follower-growth`), adapting the sketch's CSS — use straight quotes only:

```css
#nav-follower-growth .fgtl-step-eyebrow { font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--gray); margin-bottom:12px; }
#nav-follower-growth .fgtl-board2 { display:grid; grid-template-columns:1fr 360px; gap:18px; align-items:start; }
#nav-follower-growth .fgtl-search { display:flex; align-items:center; gap:9px; background:var(--bg-soft); border:1px solid var(--hairline); border-radius:9999px; padding:9px 15px; margin-bottom:14px; }
#nav-follower-growth .fgtl-search input { flex:1; border:none; background:none; outline:none; color:var(--ink); font-size:13px; font-family:var(--body); }
#nav-follower-growth .fgtl-search .clr { background:none; border:none; color:var(--gray); cursor:pointer; font-size:14px; display:none; }
#nav-follower-growth .fgtl-search .clr.show { display:block; }
#nav-follower-growth .fgtl-people { max-height:520px; overflow-y:auto; padding-right:6px; }
#nav-follower-growth .fgtl-prow { display:grid; grid-template-columns:1fr auto auto; align-items:center; gap:16px; padding:13px 14px; border:1px solid var(--hairline); border-radius:12px; margin-bottom:9px; }
#nav-follower-growth .fgtl-prow.in { opacity:.45; }
#nav-follower-growth .fgtl-prow .em { font-family:var(--mono); font-size:12.5px; color:var(--ink); }
#nav-follower-growth .fgtl-prow .meta { font-family:var(--mono); font-size:10px; color:var(--gray); margin-top:3px; }
#nav-follower-growth .fgtl-mbox { text-align:right; }
#nav-follower-growth .fgtl-mbox b { font-family:var(--display); font-size:1.5rem; line-height:1; color:var(--ink); }
#nav-follower-growth .fgtl-mbox.zero b { color:var(--gray); }
#nav-follower-growth .fgtl-mbox small { display:block; font-family:var(--mono); font-size:8.5px; letter-spacing:.07em; text-transform:uppercase; color:var(--gray); margin-top:2px; }
#nav-follower-growth .fgtl-addbtn { border:1px solid var(--ink); background:none; color:var(--ink); border-radius:9999px; padding:7px 15px; font-family:var(--mono); font-size:10px; letter-spacing:.05em; text-transform:uppercase; cursor:pointer; white-space:nowrap; }
#nav-follower-growth .fgtl-addbtn.dis { border-color:var(--hairline); color:var(--hairline); cursor:not-allowed; }
#nav-follower-growth .fgtl-cart { border:1px solid var(--hairline); border-radius:14px; padding:16px; position:sticky; top:20px; }
#nav-follower-growth .fgtl-cart h3 { font-family:var(--mono); font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--gray); margin:0 0 12px; }
#nav-follower-growth .fgtl-cart .empty { color:var(--gray); font-size:12.5px; text-align:center; padding:30px 10px; border:1px dashed var(--hairline); border-radius:10px; }
#nav-follower-growth .fgtl-pick { display:grid; grid-template-columns:1fr auto; gap:4px 10px; padding:11px 0; border-top:1px solid var(--hairline-soft); }
#nav-follower-growth .fgtl-pick:first-child { border-top:none; }
#nav-follower-growth .fgtl-pick .em { font-family:var(--mono); font-size:11.5px; color:var(--ink); }
#nav-follower-growth .fgtl-pick .acct { font-family:var(--mono); font-size:9.5px; color:var(--green); margin-top:3px; cursor:pointer; }
#nav-follower-growth .fgtl-pick .acct.gap { color:var(--red); }
#nav-follower-growth .fgtl-pick .acct.local { color:var(--gold); }
#nav-follower-growth .fgtl-pick .inv { text-align:right; font-family:var(--display); font-size:1.1rem; color:var(--ink); }
#nav-follower-growth .fgtl-pick .inv small { display:block; font-family:var(--mono); font-size:8px; text-transform:uppercase; color:var(--gray); }
#nav-follower-growth .fgtl-pick .rm { grid-column:2; justify-self:end; background:none; border:none; color:var(--gray); cursor:pointer; font-size:11px; font-family:var(--mono); }
#nav-follower-growth .fgtl-acctsel { grid-column:1 / -1; margin-top:8px; border:1px solid var(--gold); border-radius:10px; padding:8px; background:var(--bg-soft); }
#nav-follower-growth .fgtl-acctsel .psearch { width:100%; box-sizing:border-box; background:var(--card-bg); border:1px solid var(--hairline); border-radius:9999px; padding:7px 12px; font-family:var(--mono); font-size:11px; color:var(--ink); outline:none; margin-bottom:7px; }
#nav-follower-growth .fgtl-acctsel .plist { max-height:168px; overflow-y:auto; display:flex; flex-direction:column; gap:4px; }
#nav-follower-growth .fgtl-acctsel .popt { display:flex; align-items:center; gap:8px; padding:7px 10px; border:1px solid var(--hairline); border-radius:8px; cursor:pointer; font-family:var(--mono); font-size:11px; }
#nav-follower-growth .fgtl-acctsel .popt:hover, #nav-follower-growth .fgtl-acctsel .popt.sel { border-color:var(--gold); background:var(--card-bg); }
#nav-follower-growth .fgtl-acctsel .popt .dot { width:7px; height:7px; border-radius:50%; border:1px solid var(--gray); flex:none; }
#nav-follower-growth .fgtl-acctsel .popt.sel .dot { background:var(--gold); border-color:var(--gold); }
#nav-follower-growth .fgtl-acctsel .popt.localopt { color:var(--gold); }
#nav-follower-growth .fgtl-acctsel .pnone { color:var(--gray); font-family:var(--mono); font-size:10px; padding:8px 10px; }
#nav-follower-growth .fgtl-cart-foot { border-top:1px solid var(--hairline); margin-top:14px; padding-top:14px; }
#nav-follower-growth .fgtl-cart-foot .tot { display:flex; justify-content:space-between; font-family:var(--mono); font-size:12px; margin-bottom:6px; }
#nav-follower-growth .fgtl-cart-foot .tot b { font-family:var(--display); font-size:1.05rem; }
#nav-follower-growth .fgtl-go-btn { width:100%; margin-top:10px; background:var(--gold); color:#000; border:none; border-radius:9999px; padding:12px; font-family:var(--mono); font-size:12px; letter-spacing:.08em; text-transform:uppercase; cursor:pointer; font-weight:600; }
#nav-follower-growth .fgtl-go-btn:disabled { background:var(--hairline); color:var(--gray); cursor:not-allowed; }
#nav-follower-growth .fgtl-db-toggle { width:100%; text-align:left; background:none; border:none; color:var(--gray); font-family:var(--mono); font-size:11px; letter-spacing:.06em; text-transform:uppercase; cursor:pointer; padding:8px 0; }
```

- [ ] **Step 3: Verify no curly quotes and IDs present**

Run: `node -e "const s=require('fs').readFileSync('public/index.html','utf8').split('\n').slice(1456).join('\n'); if(/[“”]/.test(s)) throw new Error('curly quotes in new markup'); ['fgtl-people','fgtl-cart','fgtl-foot','fgtl-go','fgtl-db-body','fgtl-db-toggle','fgtl-search'].forEach(id=>{if(!s.includes('\"'+id+'\"'))throw new Error('missing id '+id)}); console.log('markup ok');"`
Expected: `markup ok`

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(fg): rebuild Team Launch panel to variant-A cart layout (markup)"
```

---

### Task 4: Team Launch cart logic in app.js

**Files:**
- Modify: `public/js/app.js` — the Team Launch block (state ~line 12863, helpers `initFollowerGrowth`, `fgtl*` render/launch/poll functions ~lines 13085–13360)
- Reference (source of truth for render logic): `public/sketches/fg-overhaul-A-cart.html` `<script>`

**Interfaces:**
- Consumes: `GET /api/fg/colleagues?roles=` (Task 2) → `{ colleagues:[{email,name,total,matched}] }`; `fgAccountCredit`/`_fgDb.budgets` (existing, ~line 13062) for budget-remaining-per-account; `getProfiles` data via existing `allProfilesData`; existing `fgtlLaunch`/`fgtlPoll`/`fgtlRenderCard` (the launch→poll→card path — REUSE, only repoint `fgtlPairs`); existing `escHtml`, `FG_DEFAULT_CHIPS`.
- Produces: the rebuilt cart UI driving the unchanged `POST /api/fg/team-launch/start`.

- [ ] **Step 1: Replace Team Launch state**

In `public/js/app.js` replace the `fgtl*` state block (~lines 12863–12869) with:

```js
// ── Team Launch board state (fgtl* = Follower Growth Team Launch) ──
let fgtlPeople = [];      // [{ email, name, total, matched, paired }]
let fgtlPicked = {};      // email -> { profile, pq, changing }
let fgtlChips = [];       // active role keyword chips
let fgtlBudgets = [];     // FG Budgets rows (for invites-left)
const FGTL_LOCAL = { id: 'local-browser', name: 'Local Browser' };
let _fgtlRefreshTimer = null;
```

- [ ] **Step 2: Implement the render + data functions**

Replace the old `fgtlAutoPair / fgtlRenderChips / fgtlRenderBoard / fgtlRenderGls / fgtlRenderDock / fgtlFilteredEmployees / fgtlBindBoard / fgtlPairs` functions with the cart versions. Port the rendering from `fg-overhaul-A-cart.html` (browse list, cart, searchable picker), adapted to the real IDs from Task 3 and real data:

```js
function fgtlAutoPairName(email) {
  const e = String(email || '').toLowerCase();
  const hit = (allProfilesData || []).find((p) => String(p.name || '').toLowerCase() === e);
  return hit ? hit.name : null;
}
function fgtlBudgetLeft(profileName) {
  if (!profileName || profileName === 'Local Browser') return Infinity;
  try { return fgAccountCredit(profileName); } catch (_) { return 30; }
}
function fgtlInvitesLeft(person, profileName) {
  if (!profileName) return 0;
  const b = fgtlBudgetLeft(profileName);
  return Math.max(0, Math.min(person.matched, b === Infinity ? person.matched : b));
}
function fgtlProfileNames() {
  return ['Local Browser', ...((allProfilesData || []).map((p) => p.name).filter(Boolean))];
}
function fgtlRenderChips() { /* keep existing chip rendering; ensure it calls fgtlRefreshMatched() on change */ }
function fgtlRenderPeople() {
  const el = document.getElementById('fgtl-people'); if (!el) return;
  const q = (document.getElementById('fgtl-search')?.value || '').toLowerCase();
  el.innerHTML = fgtlPeople.filter((p) => p.email.toLowerCase().includes(q)).map((p) => {
    const isIn = !!fgtlPicked[p.email]; const zero = p.matched === 0;
    return `<div class="fgtl-prow ${isIn ? 'in' : ''}">
      <div><div class="em">${escHtml(p.email)}</div><div class="meta">${p.total.toLocaleString()} total in DB${p.paired ? ' · auto-pairs' : ' · needs a profile'}</div></div>
      <div class="fgtl-mbox ${zero ? 'zero' : ''}"><b>${p.matched.toLocaleString()}</b><small>match roles</small></div>
      <button class="fgtl-addbtn ${zero ? 'dis' : ''}" data-fgadd="${escHtml(p.email)}" ${zero ? 'disabled' : ''}>${isIn ? 'added' : zero ? 'no match' : '+ add'}</button>
    </div>`;
  }).join('') || '<div class="empty" style="color:var(--gray);padding:22px;text-align:center">No colleagues match that search.</div>';
}
function fgtlRenderProfileOpts(em, prof, pq) {
  const q = (pq || '').toLowerCase();
  const hits = fgtlProfileNames().filter((n) => n.toLowerCase().includes(q));
  if (!hits.length) return '<div class="pnone">No profiles match that name</div>';
  return hits.map((n) => `<div class="popt ${prof === n ? 'sel' : ''} ${n === 'Local Browser' ? 'localopt' : ''}" data-fgopt="${escHtml(em)}" data-name="${escHtml(n)}"><span class="dot"></span>${escHtml(n)}</div>`).join('');
}
function fgtlRenderCart() {
  const el = document.getElementById('fgtl-cart'); if (!el) return;
  const emails = Object.keys(fgtlPicked);
  const card = document.getElementById('fgtl-card'); if (card) card.style.display = emails.length ? '' : 'none';
  if (!emails.length) { el.innerHTML = '<div class="empty">Add colleagues from the left.<br>You will see their paired account and how many invites they can send.</div>'; document.getElementById('fgtl-foot').style.display = 'none'; return; }
  el.innerHTML = emails.map((em) => {
    const p = fgtlPeople.find((x) => x.email === em); if (!p) return '';
    const prof = fgtlPicked[em].profile || p.paired;
    const inv = fgtlInvitesLeft(p, prof);
    const b = prof ? fgtlBudgetLeft(prof) : 0;
    const acctCls = !prof ? 'gap' : prof === 'Local Browser' ? 'local' : '';
    const showSel = !p.paired || fgtlPicked[em].changing;
    return `<div class="fgtl-pick">
      <div><div class="em">${escHtml(em)}</div><div class="acct ${acctCls}" data-fgchange="${escHtml(em)}">${prof ? escHtml(prof) + (p.paired && !fgtlPicked[em].changing ? ' · change' : '') : 'needs a profile'}</div></div>
      <div class="inv">${prof ? inv : 0}<small>${b === 0 ? 'budget 0' : 'invites'}</small></div>
      <button class="rm" data-fgrm="${escHtml(em)}">remove</button>
      ${showSel ? `<div class="fgtl-acctsel"><input class="psearch" data-fgpsearch="${escHtml(em)}" placeholder="Search profiles by name…" value="${escHtml(fgtlPicked[em].pq || '')}"><div class="plist" data-fgplist="${escHtml(em)}">${fgtlRenderProfileOpts(em, prof, fgtlPicked[em].pq || '')}</div></div>` : ''}
    </div>`;
  }).join('');
  const totInv = emails.reduce((s, em) => { const p = fgtlPeople.find((x) => x.email === em); const prof = fgtlPicked[em].profile || p.paired; return s + (prof ? fgtlInvitesLeft(p, prof) : 0); }, 0);
  document.getElementById('fgtl-t-people').textContent = emails.length;
  document.getElementById('fgtl-t-inv').textContent = totInv.toLocaleString();
  document.getElementById('fgtl-foot').style.display = 'block';
  const gaps = emails.some((em) => { const p = fgtlPeople.find((x) => x.email === em); return !(fgtlPicked[em].profile || p.paired); });
  const go = document.getElementById('fgtl-go');
  go.disabled = gaps; go.textContent = gaps ? 'Pick a profile for everyone first' : `Launch ${emails.length} sequentially`;
}
function fgtlRenderAll() { fgtlRenderPeople(); fgtlRenderCart(); }
async function fgtlRefreshMatched() {
  try {
    const roles = encodeURIComponent(fgtlChips.join(','));
    const r = await fetch(`/api/fg/colleagues?roles=${roles}`);
    const j = await r.json();
    fgtlPeople = (j.colleagues || []).map((c) => ({ ...c, paired: fgtlAutoPairName(c.email) }));
    fgtlRenderAll();
  } catch (_) {}
}
function fgtlPairs() {
  return Object.keys(fgtlPicked).map((email) => {
    const p = fgtlPeople.find((x) => x.email === email); if (!p) return null;
    const profName = fgtlPicked[email].profile || p.paired; if (!profName) return null;
    const profileId = profName === 'Local Browser' ? 'local-browser' : ((allProfilesData || []).find((x) => x.name === profName) || {}).id;
    if (!profileId) return null;
    return { operator: email, operatorName: p.name || email, account: profName, profileId };
  }).filter(Boolean);
}
```

- [ ] **Step 3: Wire events and init**

Add a single delegated event setup (call once from `initFollowerGrowth`) and repoint init:

```js
function fgtlBindBoard() {
  const root = document.getElementById('nav-follower-growth'); if (!root || root._fgtlBound) return; root._fgtlBound = true;
  root.addEventListener('click', (e) => {
    const add = e.target.closest('[data-fgadd]'); if (add && !add.disabled) { fgtlPicked[add.dataset.fgadd] = {}; fgtlRenderAll(); }
    const rm = e.target.closest('[data-fgrm]'); if (rm) { delete fgtlPicked[rm.dataset.fgrm]; fgtlRenderAll(); }
    const ch = e.target.closest('[data-fgchange]'); if (ch) { (fgtlPicked[ch.dataset.fgchange] ||= {}).changing = true; fgtlRenderCart(); }
    const opt = e.target.closest('[data-fgopt]'); if (opt) { const em = opt.dataset.fgopt; fgtlPicked[em].profile = opt.dataset.name; fgtlPicked[em].changing = false; fgtlPicked[em].pq = ''; fgtlRenderCart(); }
    if (e.target.id === 'fgtl-db-toggle') { const b = document.getElementById('fgtl-db-body'); b.style.display = b.style.display === 'none' ? 'block' : 'none'; }
    if (e.target.id === 'fgtl-search-clear') { const s = document.getElementById('fgtl-search'); s.value = ''; e.target.classList.remove('show'); fgtlRenderPeople(); }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'fgtl-search') { document.getElementById('fgtl-search-clear').classList.toggle('show', !!e.target.value); fgtlRenderPeople(); return; }
    const ps = e.target.closest('[data-fgpsearch]'); if (ps) { const em = ps.dataset.fgpsearch; fgtlPicked[em].pq = ps.value; const list = root.querySelector(`[data-fgplist="${em}"]`); if (list) { const p = fgtlPeople.find((x) => x.email === em); list.innerHTML = fgtlRenderProfileOpts(em, fgtlPicked[em].profile || p.paired, ps.value); } }
  });
  const go = document.getElementById('fgtl-go'); if (go && !go._b) { go._b = true; go.addEventListener('click', fgtlLaunch); }
}
```

Update `initFollowerGrowth()` so it: `await fgLoadDb()` (sets `_fgDb.budgets` / enables `fgAccountCredit`); ensures `allProfilesData` is loaded (existing bounded retry); seeds `if (!fgtlChips.length) fgtlChips = FG_DEFAULT_CHIPS.slice()`; calls `fgtlRenderChips()`, `fgtlBindBoard()`, then `await fgtlRefreshMatched()`. Remove any call to the old `fgFillPickers()` / `fgtlRenderBoard()` / `fgtlRenderGls()`.

Ensure `fgtlRenderChips()` (adding/removing a chip or preset) calls `fgtlRefreshMatched()` after mutating `fgtlChips` (debounce 250ms via `_fgtlRefreshTimer`: `clearTimeout(_fgtlRefreshTimer); _fgtlRefreshTimer = setTimeout(fgtlRefreshMatched, 250);`).

Confirm `fgtlLaunch`, `fgtlPoll`, `fgtlRenderCard` still exist and are unchanged except `fgtlLaunch` reads `fgtlPairs()` (new shape, same return contract `{operator,operatorName,account,profileId}`).

- [ ] **Step 4: Bump version**

In `package.json` bump `version` to `2.117.0`.

- [ ] **Step 5: Manual verification (NO live send)**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
sleep 9; tail -3 /tmp/dev-app.log   # expect "Total: NNN profiles"
```

In the app → Follower Growth. Verify:
1. Browse list shows each colleague with MATCHED (headline) + total; rows with 0 matched are disabled.
2. Removing/adding a role chip updates the matched numbers (after ~250ms).
3. "+ add" moves a person into the cart; cart shows paired account + invites-left; Antonio shows budget 0.
4. Clicking the account → searchable picker (type to filter), Local Browser pinned; selecting collapses it.
5. DB block hidden until "▸ View database" is clicked.
6. Launch with at least one picked person drives the `vj-card` live log. **Stop before any real send** — verify the card animates and the request fires; do not let a real GoLogin invite go out (use a person with budget 0 / no targets, or cancel).

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js package.json
git commit -m "feat(fg): Team Launch cart logic + matched-per-person + searchable picker (v2.117.0)"
```

---

## Self-Review

**Spec coverage:** Matched-per-colleague → Task 1. `roles` endpoint (backward compatible) → Task 2. Panel layout (browse/cart/searchable picker/Local Browser/collapsed DB/vj-card) → Tasks 3–4. Invites-left = min(matched,budget) → Task 4 (`fgtlInvitesLeft`). Reused engine/write-back/skip-reasons → untouched (no task, by design). No-arg endpoint regression guard → Task 2 Step 5 + spec success criterion.

**Placeholder scan:** `fgtlRenderChips` in Task 4 Step 2 references "keep existing chip rendering" — the existing function already renders chips and presets; the only required change is invoking the debounced `fgtlRefreshMatched()` on mutation (spelled out in Step 3). No other placeholders.

**Type consistency:** `fgtlPairs()` returns `{operator,operatorName,account,profileId}` — matches the server `/team-launch/start` filter (`p.operator && p.account && p.profileId`) and the engine. Element IDs in Task 3 match those read in Task 4. `listFgColleaguesMatched` return `{email,name,total,matched}` matches the frontend mapping and the `/api/fg/colleagues` response.
