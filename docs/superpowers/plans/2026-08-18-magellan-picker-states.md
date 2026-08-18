# Magellan Picker Readiness States + HubSpot List Fix Button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show on every Magellan account tile whether it can actually be imported into HubSpot, and let any operator add the missing accounts to the `linkedin_1st_connections` option list from the app.

**Architecture:** Pure option-merge helpers in a new `src/connections/hubspot-options.js`, network calls added to the existing `src/connections/hubspot-client.js`, one new POST endpoint in `server.js`, one pure `tileState()` helper in `public/js/magellan-view.mjs` consumed by `renderMagellanAccounts` in `public/js/app.js`, plus one new CSS band. No new data source — `importable` already reaches the browser on every account.

**Tech Stack:** vanilla JS (no bundler), Express 4, `node --test`, HubSpot CRM v3 properties API.

**Spec:** `docs/superpowers/specs/2026-08-18-magellan-picker-states-design.md`

## Global Constraints

- Tests are `node --test`. No Jest, no Vitest. Run with `npm test`.
- Frontend is vanilla JS with no bundler. `public/js/*.mjs` files are ES modules imported by both `app.js` (browser) and the tests (node) — they must contain no DOM access.
- **Never remove, reorder, or rewrite an existing option** on `linkedin_1st_connections`. Append only.
- The `PATCH` must be preceded by a fresh `GET` and followed by a verifying `GET`. A `200` that fails the read-back is a failure.
- Design system: monochrome, hairlines, radii 0 or 9999. The three status colours already exist as tokens — `--green`, `--gold`, `--red`, `--blue`. Add no new colour values.
- Red is reserved for "no SoO email exists, nothing can be done". Amber (`--gold`) means "blocked, and there is a button".
- **Off-limits files:** `src/linkedin/outreach.js` and `src/linkedin/actions.js`. Do not modify.
- Property constant is `CONNECTIONS_PROP`, already exported from `src/connections/magellan.js`.
- Existing option shape, measured: `{label, value, displayOrder, hidden: false}` where `label === value === <email>`, `displayOrder` sequential from 0.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/connections/hubspot-options.js` | **Create.** Pure functions: merge new values into an options array, and verify a read-back. No network, no DOM. |
| `tests/connections/hubspot-options.test.js` | **Create.** Unit tests for the above. |
| `src/connections/hubspot-client.js` | **Modify.** Add `connectionsProp()`, `addConnectionsOptions()`, `tokenScopes()`. Refactor `connectionsPropOptions()` to reuse `connectionsProp()`. |
| `tests/connections/hubspot-options-client.test.js` | **Create.** Client tests against a stub `fetchImpl`. |
| `server.js` | **Modify.** New `POST /api/magellan/hubspot-options/add`; add `canEditOptions` to the `/api/magellan/accounts` response. |
| `public/js/magellan-view.mjs` | **Modify.** Add pure `tileState(account)`. |
| `tests/connections/magellan-tile-state.test.js` | **Create.** Unit tests for `tileState`. |
| `public/js/app.js` | **Modify.** `renderMagellanAccounts` uses `tileState`; new filter chip; footer fix button. |
| `public/index.html` | **Modify.** Fix button element + the new filter chip. |
| `public/css/style.css` | **Modify.** `s-fixable` / `is-fixable` band; two-word wrap for `s-assigned`; `.hs-fix` button. |

---

### Task 1: Pure option-merge helpers

**Files:**
- Create: `src/connections/hubspot-options.js`
- Test: `tests/connections/hubspot-options.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normaliseValue(v) -> string` — trimmed, lowercased.
  - `mergeOptions(existing, values) -> {options, added}` — `existing` is the raw options array from HubSpot, `values` an array of email strings. Returns the full array to PATCH and the list of values actually appended. Throws if the result would be shorter than `existing` or would drop any existing value.
  - `verifyReadBack(before, after, added) -> {ok, missing}` — `before`/`after` are options arrays, `added` the values `mergeOptions` reported.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseValue, mergeOptions, verifyReadBack } from '../../src/connections/hubspot-options.js';

const opts = (...vals) => vals.map((v, i) => ({ label: v, value: v, displayOrder: i, hidden: false }));

test('normaliseValue trims and lowercases', () => {
  assert.equal(normaliseValue('  Pat.Yanguas@Ortus.Solutions '), 'pat.yanguas@ortus.solutions');
});

test('appends a missing value with the next displayOrder', () => {
  const existing = opts('a@ortus.solutions', 'b@ortus.solutions');
  const { options, added } = mergeOptions(existing, ['c@ortus.solutions']);
  assert.deepEqual(added, ['c@ortus.solutions']);
  assert.equal(options.length, 3);
  assert.deepEqual(options[2], {
    label: 'c@ortus.solutions', value: 'c@ortus.solutions', displayOrder: 2, hidden: false,
  });
});

test('leaves every existing option untouched and in order', () => {
  const existing = opts('a@ortus.solutions', 'b@ortus.solutions');
  const { options } = mergeOptions(existing, ['c@ortus.solutions']);
  assert.deepEqual(options.slice(0, 2), existing);
});

test('is idempotent for a value that is already present', () => {
  const existing = opts('a@ortus.solutions');
  const { options, added } = mergeOptions(existing, ['A@Ortus.Solutions']);
  assert.deepEqual(added, []);
  assert.deepEqual(options, existing);
});

test('de-duplicates values within one call', () => {
  const existing = opts('a@ortus.solutions');
  const { options, added } = mergeOptions(existing, ['c@ortus.solutions', 'C@ortus.solutions']);
  assert.deepEqual(added, ['c@ortus.solutions']);
  assert.equal(options.length, 2);
});

test('ignores blank values', () => {
  const existing = opts('a@ortus.solutions');
  const { added } = mergeOptions(existing, ['', '   ', null, undefined]);
  assert.deepEqual(added, []);
});

test('verifyReadBack passes when every added value is present and the count matches', () => {
  const before = opts('a@ortus.solutions');
  const after = opts('a@ortus.solutions', 'c@ortus.solutions');
  assert.deepEqual(verifyReadBack(before, after, ['c@ortus.solutions']), { ok: true, missing: [] });
});

test('verifyReadBack fails when an added value is absent', () => {
  const before = opts('a@ortus.solutions');
  const after = opts('a@ortus.solutions');
  const r = verifyReadBack(before, after, ['c@ortus.solutions']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['c@ortus.solutions']);
});

test('verifyReadBack fails when the total count does not equal before + added', () => {
  const before = opts('a@ortus.solutions', 'b@ortus.solutions');
  const after = opts('a@ortus.solutions', 'c@ortus.solutions');   // b vanished
  assert.equal(verifyReadBack(before, after, ['c@ortus.solutions']).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connections/hubspot-options.test.js`
Expected: FAIL — `Cannot find module '.../hubspot-options.js'`

- [ ] **Step 3: Write the implementation**

```js
// Pure helpers for editing the linkedin_1st_connections option list.
//
// The property PATCH replaces the ENTIRE options array — adding one option
// means sending all 1030 back. A short or reordered array does not corrupt one
// contact, it detaches the property's values across a 12.2M-contact portal.
// So the merge appends only, and refuses to produce anything else.

export function normaliseValue(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * @param {Array<{label:string,value:string,displayOrder:number,hidden:boolean}>} existing
 * @param {string[]} values
 * @returns {{options: Array, added: string[]}}
 */
export function mergeOptions(existing, values) {
  const base = Array.isArray(existing) ? existing : [];
  const have = new Set(base.map((o) => normaliseValue(o.value)));
  const options = base.slice();
  const added = [];

  for (const raw of Array.isArray(values) ? values : []) {
    const v = normaliseValue(raw);
    if (!v || have.has(v)) continue;
    have.add(v);
    added.push(v);
    options.push({ label: v, value: v, displayOrder: options.length, hidden: false });
  }

  // The guard. Cheap, and the only thing standing between a bug here and a
  // portal-wide data loss.
  if (options.length < base.length) {
    throw new Error('refusing to PATCH: merged option list is shorter than the current one');
  }
  const out = new Set(options.map((o) => normaliseValue(o.value)));
  const dropped = base.map((o) => normaliseValue(o.value)).filter((v) => !out.has(v));
  if (dropped.length) {
    throw new Error(`refusing to PATCH: would drop ${dropped.length} existing option(s)`);
  }

  return { options, added };
}

/**
 * Did the write actually land? A 200 is not evidence.
 */
export function verifyReadBack(before, after, added) {
  const have = new Set((after || []).map((o) => normaliseValue(o.value)));
  const missing = (added || []).map(normaliseValue).filter((v) => !have.has(v));
  const ok = missing.length === 0 && (after || []).length === (before || []).length + (added || []).length;
  return { ok, missing };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/connections/hubspot-options.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/connections/hubspot-options.js tests/connections/hubspot-options.test.js
git commit -m "feat: append-only merge helpers for the HubSpot connections option list"
```

---

### Task 2: HubSpot client — read the property, add options, read the token's scopes

**Files:**
- Modify: `src/connections/hubspot-client.js`
- Test: `tests/connections/hubspot-options-client.test.js`

**Interfaces:**
- Consumes: `mergeOptions`, `verifyReadBack` from Task 1; `CONNECTIONS_PROP` from `src/connections/magellan.js`.
- Produces:
  - `connectionsProp({fetchImpl, token}) -> Promise<{options: Array}>` — the raw property.
  - `addConnectionsOptions(values, {fetchImpl, token}) -> Promise<{added: string[], total: number}>` — the full read-modify-verify sequence. Throws on failure.
  - `tokenScopes({fetchImpl, token}) -> Promise<string[]>` — returns `[]` rather than throwing when the endpoint cannot be reached.

**Context the brief cannot know:** `connectionsPropOptions()` already exists at `src/connections/hubspot-client.js:377` and returns a `Set` of lowercased values. Refactor it to call `connectionsProp()` so there is one definition of how the property is read. Its existing callers and behaviour must not change.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionsProp, addConnectionsOptions, tokenScopes } from '../../src/connections/hubspot-client.js';

const opts = (...vals) => vals.map((v, i) => ({ label: v, value: v, displayOrder: i, hidden: false }));

// A stub HubSpot that holds the option list in memory and records every call.
function stubHubSpot(initial) {
  const calls = [];
  let current = initial.slice();
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'PATCH') {
      current = JSON.parse(init.body).options;
      return { ok: true, status: 200, json: async () => ({ options: current }) };
    }
    return { ok: true, status: 200, json: async () => ({ options: current }) };
  };
  return { fetchImpl, calls, now: () => current };
}

test('connectionsProp returns the raw options array', async () => {
  const hs = stubHubSpot(opts('a@ortus.solutions'));
  const p = await connectionsProp({ fetchImpl: hs.fetchImpl, token: 't' });
  assert.deepEqual(p.options, opts('a@ortus.solutions'));
});

test('addConnectionsOptions reads, patches, then reads again to verify', async () => {
  const hs = stubHubSpot(opts('a@ortus.solutions'));
  const r = await addConnectionsOptions(['c@ortus.solutions'], { fetchImpl: hs.fetchImpl, token: 't' });
  assert.deepEqual(r.added, ['c@ortus.solutions']);
  assert.equal(r.total, 2);
  assert.deepEqual(hs.calls.map((c) => c.method), ['GET', 'PATCH', 'GET']);
});

test('addConnectionsOptions sends the whole array, existing entries untouched', async () => {
  const hs = stubHubSpot(opts('a@ortus.solutions', 'b@ortus.solutions'));
  await addConnectionsOptions(['c@ortus.solutions'], { fetchImpl: hs.fetchImpl, token: 't' });
  const sent = hs.calls.find((c) => c.method === 'PATCH').body.options;
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.slice(0, 2), opts('a@ortus.solutions', 'b@ortus.solutions'));
});

test('addConnectionsOptions does not PATCH when nothing is missing', async () => {
  const hs = stubHubSpot(opts('a@ortus.solutions'));
  const r = await addConnectionsOptions(['a@ortus.solutions'], { fetchImpl: hs.fetchImpl, token: 't' });
  assert.deepEqual(r.added, []);
  assert.equal(hs.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('addConnectionsOptions throws when the read-back does not show the new value', async () => {
  const frozen = opts('a@ortus.solutions');
  const fetchImpl = async (url, init = {}) => ({
    ok: true, status: 200, json: async () => ({ options: frozen }),   // PATCH silently ignored
  });
  await assert.rejects(
    () => addConnectionsOptions(['c@ortus.solutions'], { fetchImpl, token: 't' }),
    /did not take|verify/i,
  );
});

test('tokenScopes returns the scope list', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ hubId: 2748825, scopes: ['oauth', 'crm.schemas.contacts.write'] }),
  });
  assert.deepEqual(await tokenScopes({ fetchImpl, token: 't' }), ['oauth', 'crm.schemas.contacts.write']);
});

test('tokenScopes returns [] rather than throwing when the endpoint fails', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.deepEqual(await tokenScopes({ fetchImpl, token: 't' }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connections/hubspot-options-client.test.js`
Expected: FAIL — `connectionsProp is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/connections/hubspot-client.js` (import the Task 1 helpers at the top):

```js
import { mergeOptions, verifyReadBack } from './hubspot-options.js';

export async function connectionsProp({ fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const res = await fetchImpl(`${BASE}/crm/v3/properties/contacts/${encodeURIComponent(CONNECTIONS_PROP)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HubSpot ${res.status} reading ${CONNECTIONS_PROP}`);
  const j = await res.json();
  return { options: j.options || [] };
}

/**
 * Append addresses to the property's option list.
 *
 * The PATCH replaces the entire array, so: read fresh, append only, send, then
 * read back and prove it landed. The final read is what makes this safe for two
 * operators pressing at the same moment — whoever writes second read first.
 */
export async function addConnectionsOptions(values, { fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN not set — add it to .env');
  const before = (await connectionsProp({ fetchImpl, token })).options;
  const { options, added } = mergeOptions(before, values);
  if (!added.length) return { added: [], total: before.length };

  const res = await fetchImpl(`${BASE}/crm/v3/properties/contacts/${encodeURIComponent(CONNECTIONS_PROP)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ options }),
  });
  if (!res.ok) throw new Error(`HubSpot ${res.status} updating ${CONNECTIONS_PROP}: ${await res.text()}`);

  const after = (await connectionsProp({ fetchImpl, token })).options;
  const check = verifyReadBack(before, after, added);
  if (!check.ok) {
    throw new Error(`HubSpot accepted the update but it did not take — missing: ${check.missing.join(', ') || 'count mismatch'}`);
  }
  return { added, total: after.length };
}

/**
 * Which scopes this token carries. The OAuth v1 endpoints 404 for private-app
 * tokens; oauth/v2/private-apps is the one that answers. Never throws — an
 * unknown scope list must not take the whole accounts card down with it.
 */
export async function tokenScopes({ fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  if (!token) return [];
  try {
    const res = await fetchImpl(`${BASE}/oauth/v2/private-apps/get/access-token-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenKey: token }),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.scopes) ? j.scopes : [];
  } catch {
    return [];
  }
}
```

Then refactor the existing `connectionsPropOptions` so the property is read in one place only:

```js
export async function connectionsPropOptions({ fetchImpl = fetch, token = process.env.HUBSPOT_TOKEN } = {}) {
  const { options } = await connectionsProp({ fetchImpl, token });
  return new Set(options.map((o) => String(o.value || '').trim().toLowerCase()));
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/connections/hubspot-options-client.test.js && npm test`
Expected: new file PASS (7 tests); full suite still green — `connectionsPropOptions` behaviour is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/connections/hubspot-client.js tests/connections/hubspot-options-client.test.js
git commit -m "feat: read-modify-verify writer for the HubSpot connections option list"
```

---

### Task 3: Server — the add endpoint and the capability flag

**Files:**
- Modify: `server.js` (the `/api/magellan/accounts` handler ends at ~line 2857; add the new route after `/api/magellan/collect`)

**Interfaces:**
- Consumes: `addConnectionsOptions`, `tokenScopes` from Task 2.
- Produces:
  - `POST /api/magellan/hubspot-options/add` — body `{accounts: string[]}`, responds `{added: string[], total: number}` or `{error}` with status 500.
  - `/api/magellan/accounts` response gains a sibling field: the handler now responds `{accounts: [...], canEditOptions: boolean}`.

**Existing import to extend:** `server.js:113` is `import { connectionsPropOptions } from './src/connections/hubspot-client.js';` — add `addConnectionsOptions` and `tokenScopes` to that same line. `CONNECTIONS_PROP` is **not** imported in `server.js`; either add it from `./src/connections/magellan.js` or write the property name literally in the log line.

**Ambiguity resolved:** `/api/magellan/accounts` currently responds with a bare array (`res.json(profiles.map(...))`). It must become an object so `canEditOptions` has somewhere to live. **Every caller must be updated in the same commit** — grep `api/magellan/accounts` across `public/js/` and fix each one. This mirrors the CSV bug from earlier in this project's history, where a bare array was read as `j.profiles` and silently returned zeros.

- [ ] **Step 1: Add the capability flag to the accounts response**

Cache the scope lookup the same way `magellanHsOptions` is cached (`server.js:2761`), so the card does not make an extra round trip on every render:

```js
let _magellanCanEdit = { at: 0, val: null };
async function magellanCanEditOptions({ maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (_magellanCanEdit.val !== null && Date.now() - _magellanCanEdit.at < maxAgeMs) return _magellanCanEdit.val;
  const val = (await tokenScopes()).includes('crm.schemas.contacts.write');
  _magellanCanEdit = { at: Date.now(), val };
  return val;
}
```

Then change the response's final line from `res.json(profiles.map(...))` to:

```js
    const accounts = profiles.map((p) => { /* unchanged body */ });
    res.json({ accounts, canEditOptions: await magellanCanEditOptions() });
```

- [ ] **Step 2: Update every caller**

Run: `grep -rn "api/magellan/accounts" public/ src/ tests/`
Each caller that reads the response as an array must read `j.accounts` instead, and `loadMagellanAccounts` in `app.js` must store `canEditOptions` in a module-scope variable (`mgCanEditOptions`) for Task 6.

- [ ] **Step 3: Add the route**

Place it directly after the `/api/magellan/collect` route:

```js
// Add operator addresses to HubSpot's linkedin_1st_connections option list.
// Any operator may call this — the safety is in the writer (append-only merge,
// guarded, then verified by reading the list back), not in who presses it.
app.post('/api/magellan/hubspot-options/add', async (req, res) => {
  try {
    const accounts = ((req.body || {}).accounts || []).filter(Boolean);
    if (!accounts.length) return res.status(400).json({ error: 'no accounts given' });
    const out = await addConnectionsOptions(accounts);
    // The cached option list and capability flag are now stale by definition.
    _magellanHsOptions = { at: 0, set: null };
    console.log(`[magellan] added ${out.added.length} option(s) to ${CONNECTIONS_PROP}: ${out.added.join(', ')}`);
    res.json(out);
  } catch (err) {
    console.warn(`[magellan] could not add options — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Verify by hand, against the running app**

Mint a session cookie per the repo's operator rules, then:

```bash
curl -s -H "Cookie: ortus_session=<body>.<sig>" http://localhost:7847/api/magellan/accounts | head -c 400
```

Expected: an object with `accounts` and `canEditOptions: true`. Do **not** exercise the POST against the live portal yet — Task 6 does that once, deliberately, with one real account.

- [ ] **Step 5: Commit**

```bash
git add server.js public/js/app.js
git commit -m "feat: endpoint to add operator addresses to the HubSpot connections list"
```

---

### Task 4: `tileState` — the pure state decision

**Files:**
- Modify: `public/js/magellan-view.mjs`
- Test: `tests/connections/magellan-tile-state.test.js`

**Interfaces:**
- Consumes: an account object from `/api/magellan/accounts` (`{account, resolved, ambiguous, importable, collected, count, collectedAt}`).
- Produces: `tileState(account) -> {kind, band, word, tone}` where `kind` is one of `'ready' | 'fixable' | 'nosoo' | 'unknown'`.

**Why a helper:** the precedence between "no SoO email" and "not on the list" is a rule, not a rendering detail, and it is the one thing in this feature that is easy to get backwards. It gets its own tested function rather than living inside a template string.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { tileState } from '../../public/js/magellan-view.mjs';

const acc = (over = {}) => ({ account: 'a@ortus.solutions', resolved: true, importable: true, collected: false, ...over });

test('resolved and importable is the ordinary state', () => {
  assert.equal(tileState(acc({ collected: true })).kind, 'ready');
  assert.equal(tileState(acc({ collected: true })).word, 'DONE');
  assert.equal(tileState(acc({ collected: false })).word, 'TO DO');
});

test('not importable is fixable, and amber', () => {
  const s = tileState(acc({ importable: false }));
  assert.equal(s.kind, 'fixable');
  assert.equal(s.band, 's-fixable');
  assert.equal(s.tone, 'amber');
});

test('no SoO email beats not-importable — it is a dead end, not a button', () => {
  const s = tileState(acc({ resolved: false, importable: false }));
  assert.equal(s.kind, 'nosoo');
  assert.equal(s.tone, 'red');
});

test('no SoO email beats importable true as well', () => {
  assert.equal(tileState(acc({ resolved: false, importable: true })).kind, 'nosoo');
});

test('importable null is its own state, never green', () => {
  const s = tileState(acc({ importable: null }));
  assert.equal(s.kind, 'unknown');
  assert.notEqual(s.tone, 'green');
});

test('collected is irrelevant to which state wins', () => {
  assert.equal(tileState(acc({ importable: false, collected: true })).kind, 'fixable');
  assert.equal(tileState(acc({ importable: false, collected: false })).kind, 'fixable');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/connections/magellan-tile-state.test.js`
Expected: FAIL — `tileState is not a function`

- [ ] **Step 3: Write the implementation**

Append to `public/js/magellan-view.mjs`:

```js
/**
 * Which of the four states a tile is in.
 *
 * The precedence matters and is easy to get backwards: an account with no SoO
 * email is a DEAD END regardless of the HubSpot list — there is no address to
 * add, so no button can help. That must beat "not on the list", which is a
 * one-click problem. Red means nothing you can do; amber means press the button.
 */
export function tileState(a = {}) {
  if (!a.resolved) {
    return { kind: 'nosoo', band: 's-nosoo', word: 'NO SoO', tone: 'red' };
  }
  if (a.importable === false) {
    return { kind: 'fixable', band: 's-fixable', word: 'NEEDS<br>HS LIST', tone: 'amber' };
  }
  if (a.importable == null) {
    return { kind: 'unknown', band: 's-assigned', word: 'HS<br>UNKNOWN', tone: 'blue' };
  }
  return a.collected
    ? { kind: 'ready', band: '', word: 'DONE', tone: 'grey' }
    : { kind: 'ready', band: 's-free', word: 'TO DO', tone: 'green' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/connections/magellan-tile-state.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add public/js/magellan-view.mjs tests/connections/magellan-tile-state.test.js
git commit -m "feat: tileState helper deciding a Magellan account tile's readiness state"
```

---

### Task 5: The tile, the CSS band, and the filter chip

**Files:**
- Modify: `public/css/style.css` (after the `s-nosoo` rules, ~line 1299)
- Modify: `public/js/app.js` (`renderMagellanAccounts`, ~line 27808; `magellanVisible`, ~line 27797; `updateMagellanCounts`, ~line 27853)
- Modify: `public/index.html` (`#mg-chips`, line 780)

**Interfaces:**
- Consumes: `tileState` from Task 4.
- Produces: no new exports. `magellanVisible` gains a `'fixable'` filter case.

**Reference:** the agreed appearance is `public/sketches/2026-08-18-magellan-picker-states.html`, variant B. Open it and match it.

- [ ] **Step 1: Add the CSS**

```css
/* Blocked-but-fixable: the account's address is not on HubSpot's
   linkedin_1st_connections option list, so its people cannot be imported.
   AMBER, deliberately not red — s-nosoo above is red because no SoO email
   exists and nothing can be done. This one is one button press from working. */
.browse-card .profile-item.jt .jt-stat.s-fixable { background:rgba(247,190,104,0.16); }
.browse-card .profile-item.jt .s-fixable .jt-dot { background:var(--gold); }
.browse-card .profile-item.jt .s-fixable .jt-word { color:var(--gold); font-size:0.82rem; text-align:center; line-height:1.15; }
.browse-card .profile-item.jt.is-fixable .jt-email { color:var(--gold); }
/* HS UNKNOWN is two words like NEEDS HS LIST — same wrap treatment. */
.browse-card .profile-item.jt .s-assigned .jt-word { font-size:0.82rem; text-align:center; line-height:1.15; }
```

- [ ] **Step 2: Use `tileState` in the renderer**

In `renderMagellanAccounts`, replace the hardcoded status markup. The existing `sub` composition stays, with the state's sentence prepended for the two blocked kinds:

```js
    const st = tileState(a);
    let sub = a.collected
      ? `${mgNum(a.count || 0)} collected on ${when}. Tick to collect again.`
      : 'Never collected.';
    if (a.resolved && a.profile && a.profile !== a.account) sub = `${a.profile} · ${sub}`;
    if (st.kind === 'nosoo') {
      sub = a.ambiguous
        ? `Two SoO accounts match this name — can't tell which. ${sub}`
        : `No email found in the SoO for this profile — it can be collected, but not imported. ${sub}`;
    } else if (st.kind === 'fixable') {
      sub = `Not on the HubSpot "Linkedin 1st Connections" list yet — one click below fixes it. ${sub}`;
    } else if (st.kind === 'unknown') {
      sub = `HubSpot didn't answer in time, so we don't know if this one can be imported. ${sub}`;
    }

    item.className = 'profile-item jt ' + (a.collected ? 'is-done' : 'free')
      + (on ? ' selected' : '')
      + (st.kind === 'nosoo' ? ' is-nosoo' : '')
      + (st.kind === 'fixable' ? ' is-fixable' : '');
    item.innerHTML = `
      <div class="jt-stat ${st.band}">
        <span class="jt-dot"></span>
        <span class="jt-word ${a.collected ? 'w-done' : 'w-todo'}">${st.word}</span>
      </div>
      <div class="jt-det">
        <div class="jt-top">
          <input type="checkbox" ${on ? 'checked' : ''} />
          <span class="jt-email">${escHtml(a.account)}</span>
        </div>
        <div class="jt-sub">${sub}</div>
      </div>`;
```

Blocked accounts stay tickable — do not add `is-restricted` or disable the checkbox.

- [ ] **Step 3: Add the filter**

In `magellanVisible`, before the existing cases:

```js
    if (mgFilter === 'fixable') return a.resolved && a.importable === false;
```

In `public/index.html` after the `Selected` chip:

```html
                  <button type="button" class="chip" data-filter="fixable" onclick="setMagellanFilter('fixable')">Needs HubSpot list <span class="count" id="mg-count-fixable">0</span></button>
```

In `updateMagellanCounts`:

```js
  set('mg-count-fixable', mgAccounts.filter((a) => a.resolved && a.importable === false).length);
```

- [ ] **Step 4: Verify in the app**

Bump the patch version in `package.json` and the `?v=` query on both `index.html` script tags, then relaunch:

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
lsof -ti :7847 | xargs kill -9 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Confirm by eye on the Magellan card: amber `NEEDS HS LIST` tiles, a red `NO SoO` tile, and the chip reading `Needs HubSpot list 170`. If the count is not 170, stop and measure before continuing — the number is known.

- [ ] **Step 5: Commit**

```bash
git add public/css/style.css public/js/app.js public/index.html package.json
git commit -m "feat: Magellan tiles show whether an account can be imported"
```

---

### Task 6: The fix button

**Files:**
- Modify: `public/index.html` (next to `#mg-sel-split`, line 815)
- Modify: `public/js/app.js` (`updateMagellanCounts`, the `#mg-sel-split` block)

**Interfaces:**
- Consumes: `selectionSummary` (existing), `mgCanEditOptions` (Task 3), `POST /api/magellan/hubspot-options/add` (Task 3).
- Produces: `window.magellanAddHubspotOptions(btn)`.

- [ ] **Step 1: Add the button element**

```html
            <button type="button" class="hs-fix" id="mg-fix-hs" hidden onclick="magellanAddHubspotOptions(this)"></button>
```

With the CSS, beside the other Magellan rules:

```css
/* Adds the selected addresses to HubSpot's linkedin_1st_connections list.
   Amber to match the tiles it clears, and deliberately not the gold Start CTA's
   filled treatment — this is a fix-up, not the primary action on the card. */
.hs-fix { font-family:var(--mono); font-size:11px; letter-spacing:.05em; text-transform:uppercase;
  background:none; border:1px solid var(--gold); color:var(--gold); border-radius:9999px;
  padding:5px 14px; cursor:pointer; white-space:nowrap; }
.hs-fix:hover { background:rgba(247,190,104,0.10); }
.hs-fix[disabled] { opacity:.5; cursor:default; }
```

- [ ] **Step 2: Show and label it**

Inside `updateMagellanCounts`, in the same block that already computes `sel`:

```js
  const fix = document.getElementById('mg-fix-hs');
  if (fix) {
    // Hidden when there is nothing to fix, and when the token cannot edit
    // properties at all — a button that always 403s is worse than no button.
    const canShow = sel.known && sel.blocked.length > 0 && mgCanEditOptions;
    fix.hidden = !canShow;
    if (canShow) {
      fix.textContent = `Add ${sel.blocked.length} to the HubSpot list`;
      fix.dataset.accounts = JSON.stringify(sel.blocked);
    }
  }
```

When `mgCanEditOptions` is false the existing split sentence still names the blocked accounts, so the operator can see what to ask for.

- [ ] **Step 3: Wire the press**

```js
// Adds the selected blocked addresses to HubSpot's option list. The server does
// the read-modify-verify; this only reports. Never says "Added" off a 200 —
// the server has already proved the values are on the list by reading it back.
async function magellanAddHubspotOptions(btn) {
  const accounts = JSON.parse(btn.dataset.accounts || '[]');
  if (!accounts.length) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const res = await fetch('/api/magellan/hubspot-options/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    btn.textContent = `Added ${j.added.length} ✓`;
    // Re-read so the tiles that were amber turn green. `fresh` bypasses the
    // server's 5-minute option-list cache, which the endpoint has already cleared.
    await loadMagellanAccounts({ keepSelection: true, fresh: true });
  } catch (err) {
    btn.textContent = label;
    showMagellanError(`Could not add to the HubSpot list — ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}
window.magellanAddHubspotOptions = magellanAddHubspotOptions;
```

- [ ] **Step 4: Verify once, for real**

Bump the version, relaunch as in Task 5, then on the Magellan card:

1. Filter to `Needs HubSpot list`, tick **one** account — use `somnath.mandal@ortus.solutions`, the account that started this.
2. Press the button. It must read `Added 1 ✓` and the tile must turn green without a manual refresh.
3. Confirm independently, against the live portal:

```bash
node -e '
const fs=require("fs");
const t=(fs.readFileSync(".env","utf8").match(/^HUBSPOT_TOKEN=(.*)$/m)||[])[1].trim();
fetch("https://api.hubapi.com/crm/v3/properties/contacts/linkedin_1st_connections",{headers:{Authorization:"Bearer "+t}})
.then(r=>r.json()).then(j=>{
  const v=j.options.map(o=>o.value.toLowerCase());
  console.log("options:",v.length,"(was 1029)");
  console.log("somnath present:",v.includes("somnath.mandal@ortus.solutions"));
});'
```

Expected: `options: 1030` and `somnath present: true`. If the count moved by anything other than the number added, stop — that is the failure mode the whole design exists to prevent.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add public/index.html public/js/app.js public/css/style.css package.json
git commit -m "feat: add blocked accounts to the HubSpot connections list from the picker"
```

---

## Final verification

- [ ] `npm test` green
- [ ] The four tile states render as in the sketch: green/grey ready, amber fixable, red no-SoO, blue unknown
- [ ] `Needs HubSpot list` chip count matches the measured 170 (169 after Task 6's verification adds one)
- [ ] The button is absent when nothing is selected, absent when nothing selected is blocked
- [ ] The live portal's option count moved by exactly the number added, and no existing option changed
