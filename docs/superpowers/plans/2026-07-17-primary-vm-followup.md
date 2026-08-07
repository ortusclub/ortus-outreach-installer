# Primary Follow-up on the VM (Cookie Handoff) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the CC+IC auto follow-up (sent AS the campaign's primary) from the local-browser workaround onto the VM, by shipping the primary's LinkedIn session cookies to the engine and running the follow-up there — with a hard identity gate and a visible "needs login" state when the session is dead.

**Architecture:** App reads the primary's linkedin.com cookie jar via CDP off the existing local handshake browser and POSTs it to the engine (Bearer-authed). Engine stores it in a new Postgres table keyed by member ID. At follow-up time the engine launches a fresh ephemeral plain-Chromium, injects the jar, verifies the logged-in identity equals the campaign's expected primary, and sends in-thread. Dead session → job parks + `needs_login` surfaces on dashboard strips, the campaign-tab status card, the creation wizard, and (on the primary's own machine) a top-level nudge.

**Tech Stack:** Node ≥22, Express 4, Postgres (Cloud SQL), Redis (locks), puppeteer-core / Playwright chromium (engine), puppeteer-core (app local browser), vanilla JS frontend.

**Two repos:**
- **APP** = `/Users/antoniovarlese/ortus-gologin-clone`
- **ENGINE** = `/Users/antoniovarlese/Desktop/Projects/ortus-salesnav-scraper-cloud`

## Global Constraints

- No plaintext credential (password) ever stored, logged, or transmitted. Cookies only.
- Cookie jars live ONLY in the engine Postgres store; never rendered in any UI; never written to app local disk.
- Identity key is the LinkedIn numeric **member ID**; campaign→primary join is via the **public_identifier** (vanity slug) parsed from the campaign's stored `primaryUrl`.
- Auto-ACCEPT stays on the local browser (unchanged). ONLY the follow-up moves to the VM.
- No residential proxies (posture 1: accept + observe). No PVC, no GCS bucket — Postgres is the only durable store.
- No persistent Chromium user-data-dir for primaries: re-inject the cookie jar into a fresh ephemeral context every launch.
- Engine API auth: `Authorization: Bearer <SHARED_TOKEN>` (`ENGINE_SHARED_TOKEN || APP_PASSWORD`), same as all `/api/*` engine routes.
- Reuse existing primitives, do not reimplement: `readSelfIdentity` (identity), `sn:proflock` lock pattern (serialization), `campaign_tasks` queue (scheduling), `campaigns-client.requestOnce` (app→engine calls).

---

## File Structure

**Repo facts pinned by exploration (do not re-derive):**
- Engine is **CJS** by default (`require`/`module.exports`); modules under
  `campaign-lib/**` are ESM and imported via dynamic `import()`. New engine
  files are CJS and reach `readSelfIdentity` via `await import()`.
- Engine automation lib = **puppeteer-core** (`campaign-browser.js`). The
  primary browser MUST be puppeteer so `sendInThread` + `readSelfIdentity`
  (both puppeteer-flavoured) work unchanged and `page.setCookie(...jar)`
  takes the app's puppeteer-shaped jar with NO translation.
- `readSelfIdentity(page,{log})` → `{name, profileUrl}` where `profileUrl =
  https://www.linkedin.com/in/<slug>/` (`accept-invitation.js:117`).
- `withAccountSession(profileId, fn)` (`campaign-runtime.js:384`) → `{retry:true}`
  or `{result}`; wraps `store.acquireAccount`/`openSession`/`releaseAccount`.
- `store.acquireAccount(key)` = Redis `SET sn:proflock:<key> pod NX EX 120`;
  passing `'primary:'+memberId` yields a unique per-primary lock — reuse it.
- follow_up payload (`campaign-autointro.js:322`): `{threadUrl, body, leadUrl,
  leadName, primaryName, primaryUrl, sender, introTitle, profileId}`.
- Scheduler registers `follow_up`→`handleFollowUp` (`campaign-runtime.js:483`).

**ENGINE — new/modified files**
- `db/campaigns-schema.sql` (modify) — `campaign_primaries` table + slug index.
- `campaign-store.js` (modify) — primary-registry accessors + orphaned-task reaper.
- `primary-session.js` (create, CJS) — puppeteer-core plain-Chromium launch +
  `page.setCookie` inject + `assertPrimaryIdentity` + pure slug/match helpers.
- `campaign-runtime.js` (modify) — `handleFollowUp` routes by `primarySource`:
  GoLogin-primary via that profile; personal-primary via injected session + gate;
  park on dead/mismatch.
- `campaign-api.js` (modify) — `POST /api/primaries/:memberId/session` +
  `GET /api/primaries/by-slug/:slug`; add `primarySession` to status payloads.
- `campaign-scheduler.js` (modify) — call the reaper each tick.

**APP — new/modified files**
- `src/primary-cookie-capture.js` (create) — read jar via `page.cookies()` +
  identity, POST to engine. Fires ONLY for personal (`local-browser`) primaries.
- `src/cloud-preflight-handshake.js` (modify) — capture after the primary
  handshake accepts (the `primaryPage` is in scope there).
- `src/campaigns-client.js` (modify) — `postPrimarySession`, `getPrimarySession`.
- `server.js` (modify) — `GET /api/primary-session?primaryUrl=` proxy for the wizard.
- `public/js/app.js` (modify) — strips badge, card #2 banner, wizard hint, personal nudge.

**NOT needed (exploration):** no app-side change to disable a local cloud
follow-up — the app never enqueues cloud follow-ups (`buildFollowUpTask` fires
only in the LOCAL `src/linkedin/auto-intro.js:212`). The old "Task 7" is dropped.

---

## Task 1 (ENGINE): `campaign_primaries` table + store accessors

**Files:**
- Modify: `db/campaigns-schema.sql` (after the `campaign_primary_conn` block, ~line 133)
- Modify: `campaign-store.js` (add accessors near the other primary accessors ~line 422)
- Test: `test/primary-store.test.js` (create)

**Interfaces — Produces:**
- `upsertPrimarySession({memberId, publicIdentifier, displayName, cookies})` → sets `state='live'`, `captured_at=now()`, ON CONFLICT(member_id) DO UPDATE.
- `getPrimaryByMember(memberId)` → row | null.
- `getPrimaryBySlug(publicIdentifier)` → row | null (case-insensitive).
- `setPrimaryState(memberId, state)` → void, `state ∈ {'live','needs_login'}`.

- [ ] **Step 1: Schema.** Add to `db/campaigns-schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS campaign_primaries (
  member_id          text PRIMARY KEY,
  public_identifier  text,
  display_name       text,
  cookies            jsonb NOT NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  state              text NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_campaign_primaries_slug
  ON campaign_primaries (lower(public_identifier));
```

- [ ] **Step 2: Write failing test** `test/primary-store.test.js` — upsert then read-back by member and by slug (lower-cased), and `setPrimaryState` flips state. Match the existing test harness in `test/` (same pg test-db setup other store tests use — read one first).

- [ ] **Step 3: Implement accessors** in `campaign-store.js` mirroring the parameterized-query style already in that file (`pool.query(text, params)`). `getPrimaryBySlug` uses `WHERE lower(public_identifier)=lower($1)`.

- [ ] **Step 4: Run** `npm test` (or the file's runner) → pass.
- [ ] **Step 5: Commit** `feat(engine): campaign_primaries registry + store accessors`.

---

## Task 2 (ENGINE): orphaned follow_up/accept reaper

**Files:**
- Modify: `campaign-store.js` (new `reapOrphanedTasks(maxClaimedMs)`)
- Modify: `campaign-scheduler.js` (call it in the tick, ~line 46)
- Test: `test/task-reaper.test.js` (create)

**Why:** exploration confirmed `claimNextDueTask` only picks `status='pending'`; a pod dying between claim and mark strands `follow_up`/`accept` rows in `claimed` forever. Park/resume correctness depends on recovery.

**Interfaces — Produces:** `reapOrphanedTasks(maxClaimedMs = 10*60*1000)` → `{reaped:number}`; returns `follow_up`/`accept` rows whose `claimed_at < now()-interval` to `status='pending'`.

- [ ] **Step 1: Failing test** — insert a `follow_up` row `status='claimed'`, `claimed_at` 15 min ago; assert `reapOrphanedTasks()` flips it to `pending` and leaves a fresh `claimed` row alone.

- [ ] **Step 2: Implement:**

```sql
UPDATE campaign_tasks
   SET status='pending', claimed_by=NULL, claimed_at=NULL
 WHERE type IN ('follow_up','accept')
   AND status='claimed'
   AND claimed_at < now() - ($1::int * interval '1 millisecond')
RETURNING id;
```

- [ ] **Step 3: Wire** into `campaign-scheduler.js` tick before `claimNextDueTask` (best-effort, log count if > 0).
- [ ] **Step 4: Run test → pass.**
- [ ] **Step 5: Commit** `fix(engine): reap orphaned claimed follow_up/accept tasks`.

---

## Task 3 (ENGINE): `primary-session.js` — launch + inject + identity gate

**Files:**
- Create: `primary-session.js` (CJS)
- Test: `test/primary-identity.test.js` (create — pure helpers only)

**Interfaces — Consumes:** `readSelfIdentity` (ESM, `campaign-lib/linkedin/accept-invitation.js`, via dynamic `import()`); puppeteer-core (already a dep); a Chromium binary on the VM.
**Produces (all `module.exports`):**
- `slugFromUrl(url)` → lower-cased slug from a LinkedIn `/in/<slug>` URL, else `''`.
- `identityMatches(selfProfileUrl, expectedSlug)` → bool (pure).
- `launchPrimarySession(cookies)` → `{browser, page, close()}` — throwaway puppeteer-core Chromium, cookies injected via `page.setCookie(...cookies)` (jar is ALREADY puppeteer-shaped — no translation). `close()` closes the browser AND removes the temp user-data-dir.
- `assertPrimaryIdentity(page, expectedSlug, deps?)` → `{ok:true, name}` | `{ok:false, reason}` (`'not_logged_in'` | `'identity_mismatch'`).

- [ ] **Step 1: Failing test** `test/primary-identity.test.js` (match the harness of an existing engine test — read one first; use `node:test` + `require` since the file is CJS):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identityMatches, slugFromUrl } = require('../primary-session.js');

test('slug is case-insensitive, ignores trailing slash/query', () => {
  assert.equal(slugFromUrl('https://www.linkedin.com/in/Antonio-Varlese/'), 'antonio-varlese');
  assert.equal(slugFromUrl('https://www.linkedin.com/in/antonio-varlese?x=1'), 'antonio-varlese');
  assert.equal(slugFromUrl('https://www.linkedin.com/feed/'), '');
  assert.equal(identityMatches('https://www.linkedin.com/in/Antonio-Varlese/', 'antonio-varlese'), true);
  assert.equal(identityMatches('https://www.linkedin.com/in/someone-else', 'antonio-varlese'), false);
  assert.equal(identityMatches('', 'antonio-varlese'), false);
});
```

- [ ] **Step 2: Implement the module.** Full code:

```js
// primary-session.js — throwaway plain-Chromium running a PERSONAL primary's
// injected LinkedIn session, so a CC+IC follow-up can be sent AS the primary on
// the VM. Puppeteer-core (not Playwright) so the vendored sendInThread /
// readSelfIdentity primitives work unchanged and the app's puppeteer cookie jar
// injects with no shape translation.
const puppeteer = require('puppeteer-core');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A Chromium binary must exist on the VM. Reuse the Playwright-installed chromium
// (the image already runs `npx playwright install chromium`); override via env.
// ponytail: single env knob — set PRIMARY_CHROME_PATH if the image ships another chrome.
function chromeExecutable() {
  if (process.env.PRIMARY_CHROME_PATH) return process.env.PRIMARY_CHROME_PATH;
  return require('playwright').chromium.executablePath();
}

function slugFromUrl(url) {
  const m = String(url || '').match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}
function identityMatches(selfProfileUrl, expectedSlug) {
  const got = slugFromUrl(selfProfileUrl);
  return !!got && !!expectedSlug && got === String(expectedSlug).toLowerCase();
}

async function launchPrimarySession(cookies) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary_'));
  const browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    // HEADED, on the Xvfb display (DISPLAY=:99) the entrypoint already boots and
    // that Orbita/GoLogin renders to — inherited from process env. Matches how
    // every browser runs on this VM, so LinkedIn sees the same headed rendering
    // it already tolerates. (Dockerfile HEADLESS=false; k8s: "MUST be false so
    // Orbita renders to the Xvfb display".) Never headless here.
    headless: false,
    userDataDir,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  if (Array.isArray(cookies) && cookies.length) await page.setCookie(...cookies);
  const close = async () => {
    try { await browser.close(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };
  return { browser, page, close };
}

async function assertPrimaryIdentity(page, expectedSlug, deps = {}) {
  const readSelf = deps.readSelfIdentity
    || (await import('./campaign-lib/linkedin/accept-invitation.js')).readSelfIdentity;
  const self = await readSelf(page).catch(() => ({}));
  if (!self || !self.profileUrl) return { ok: false, reason: 'not_logged_in' };
  if (!identityMatches(self.profileUrl, expectedSlug)) return { ok: false, reason: 'identity_mismatch', got: self.profileUrl };
  return { ok: true, name: self.name };
}

module.exports = { slugFromUrl, identityMatches, launchPrimarySession, assertPrimaryIdentity, chromeExecutable };
```

- [ ] **Step 3: Run** the pure-helper test → pass.
- [ ] **Step 4: Report the browser-launch caveat explicitly** — `launchPrimarySession`/`assertPrimaryIdentity` are NOT unit-tested (need a live session + Chromium binary); only the pure helpers are. Launch is HEADED on the VM's Xvfb `:99` (resolved — see Notes), so no headless behaviour to smoke-test; the residual live check is simply that an injected personal-primary session sends one real follow-up on the VM post-deploy. State this in the report; do NOT fake a browser test.
- [ ] **Step 5: Commit** `feat(engine): primary session launch + cookie injection + identity gate`.

---

## Task 4 (ENGINE): follow-up routes to the correct primary identity

**Files:**
- Modify: `campaign-runtime.js` (`handleFollowUp` at line 394; it already closes over `store`, `d`, `withAccountSession`)
- Test: `test/followup-as-primary.test.js` (create — inject deps, no real browser)

**Interfaces — Consumes:** Task 1 accessors (`getPrimaryBySlug`, `setPrimaryState`, `acquireAccount`/`releaseAccount`), Task 3 module (`slugFromUrl`, `launchPrimarySession`, `assertPrimaryIdentity`), existing `d.sendFollowUp({page,payload})` (already wraps `sendInThread`, `campaign-runtime.js:130`), existing `withAccountSession`.

**The bug being fixed:** current `handleFollowUp` sends via `withAccountSession(payload.profileId, …)` where `payload.profileId` is the GoLogin **sender** — so the follow-up posts as the wrong person. Route by `payload.sender` (= the primary's source) instead.

- [ ] **Step 1: Failing test** with injected deps (fake `store`, fake `primarySession` module, spy `sendFollowUp`). Cover:
  - (a) `sender` = a GoLogin profileId → sends via `withAccountSession(sender)`; `sendFollowUp` called once, task done.
  - (b) `sender='local-browser'`, no primary row → parked (`rescheduleInMs≈30min`), `sendFollowUp` NOT called.
  - (c) `sender='local-browser'`, row `state='needs_login'` → parked, not sent.
  - (d) `sender='local-browser'`, live row, identity mismatch → `setPrimaryState(member,'needs_login')` + parked + not sent.
  - (e) `sender='local-browser'`, live row, gate ok → `sendFollowUp` called once, session closed, lock released, task done.

- [ ] **Step 2: Make the launcher/gate injectable.** At the top of the runtime factory (near the other `d.*` defaults) add `const _ps = d.primarySession || require('./primary-session.js');` so the test can inject a fake. Keep `d.sendFollowUp` as-is.

- [ ] **Step 3: Replace `handleFollowUp`** (lines 394-400) with:

```js
async function handleFollowUp(task) {
  const payload = task.payload || {};
  const primarySource = payload.sender || 'local-browser';

  // Primary is on GoLogin → send as the primary's OWN profile (not the sender).
  if (primarySource !== 'local-browser') {
    const out = await withAccountSession(primarySource, (session) =>
      d.sendFollowUp({ page: session.page, payload }));
    if (out.retry) return { rescheduleInMs: 5 * 60000 };
    return { status: 'done' };
  }

  // Personal primary (not on GoLogin) → cookie-injected VM session + identity gate.
  const slug = _ps.slugFromUrl(payload.primaryUrl);
  const row = slug ? await store.getPrimaryBySlug(slug) : null;
  if (!row || row.state === 'needs_login') {
    d.log(`follow_up parked: primary ${slug || '(no slug)'} has no live session`);
    return { rescheduleInMs: 30 * 60000 }; // park; resumes when fresh cookies arrive
  }
  // One browser per identity across ALL that primary's campaigns.
  if (!(await store.acquireAccount('primary:' + row.member_id))) return { rescheduleInMs: 5 * 60000 };
  let session = null;
  try {
    session = await _ps.launchPrimarySession(row.cookies);
    const gate = await _ps.assertPrimaryIdentity(session.page, slug);
    if (!gate.ok) {
      d.log(`⚠ follow_up BLOCKED: primary ${slug} session ${gate.reason}${gate.got ? ' (got ' + gate.got + ')' : ''} — parking + needs_login`);
      await store.setPrimaryState(row.member_id, 'needs_login');
      return { rescheduleInMs: 30 * 60000 };
    }
    await d.sendFollowUp({ page: session.page, payload });
    return { status: 'done' };
  } finally {
    if (session && session.close) { try { await session.close(); } catch {} }
    await store.releaseAccount('primary:' + row.member_id);
  }
}
```

- [ ] **Step 4: Run test → pass.**
- [ ] **Step 5: Commit** `fix(engine): send CC+IC follow-up as the primary, not the sender`.

---

## Task 5 (ENGINE): `primarySession` in status payload + session endpoint

**Files:**
- Modify: `campaign-api.js` (`GET /api/campaign/:id` ~139; `list` ~120; add `POST /api/primaries/:memberId/session`)
- Test: `test/primary-session-endpoint.test.js` (create)

**Interfaces — Produces:**
- Status payload gains `primarySession: {state:'live'|'needs_login'|'none', name, parked:number}` — joined via the campaign's primary slug. NOTE (corrected during build): the `campaigns` table has no `primary_url` column; the URL is `campaign.config.primaryUrl` (config jsonb IS the templates object). Derive slug from that → `getPrimaryBySlug`. Do not require `primary-session.js` from store/api (it loads puppeteer) — inline the slug regex. `parked` = count of this campaign's `follow_up` rows still `pending` with `due_at > now()` (rescheduled, not yet sent). `'none'` when the campaign has no primary URL or nothing has been captured yet. Only meaningful for personal (`local-browser`) primaries; a GoLogin-primary campaign reads `'none'` (its follow-up never parks on a session).
- `POST /api/primaries/:memberId/session` body `{publicIdentifier, displayName, cookies}` → `upsertPrimarySession(...)` → re-queue this member's parked follow-ups, return `{ok:true, resumed:n}`.
- `GET /api/primaries/by-slug/:slug` → `{state, name, capturedAt}` | `{state:'none'}` — backs the app wizard hint (Task 8).

- [ ] **Step 1: Failing test** — POST session then GET campaign status shows `primarySession.state='live'`; a `needs_login` row shows `needs_login`; POST resumes parked tasks (asserts their `due_at` moved to ≈ now); `by-slug` returns the row's state.

- [ ] **Step 2: Implement `POST .../session`** (Bearer-guarded like siblings — `if (need(res)) return`). Resume targets the parked rows by the primary's slug in the payload (personal follow-ups carry `sender='local-browser'` + `primaryUrl`):

```sql
UPDATE campaign_tasks
   SET due_at = now(), status = 'pending'
 WHERE type = 'follow_up'
   AND status = 'pending'
   AND payload->>'sender' = 'local-browser'
   AND lower(payload->>'primaryUrl') LIKE '%/in/' || $1 || '%'   -- $1 = public_identifier (lower)
RETURNING id;
```

`ponytail:` slug LIKE-match on the payload — fine at this scale; add a `member_id` to the follow_up payload later only if it gets fussy.

- [ ] **Step 3: Implement `GET .../by-slug/:slug`** → `getPrimaryBySlug` mapped to `{state, name, capturedAt}` (or `{state:'none'}`).

- [ ] **Step 4: Add `primarySession`** to both `GET /:id` (`campaign-api.js:146`) and the explicit-column `list` (`:125`) payloads — `list` builds objects by name, so add the join there too.

- [ ] **Step 5: Run test → pass. Commit** `feat(engine): primarySession status + session-upload + by-slug endpoints`.

---

## Task 6 (APP): cookie capture off the handshake browser

**Files:**
- Create: `src/primary-cookie-capture.js`
- Modify: `src/cloud-preflight-handshake.js` (after Phase-2 accept, ~line 243, primaryPage in scope)
- Modify: `src/campaigns-client.js` (add `postPrimarySession`)
- Test: `tests/primary-cookie-capture.test.js` (create)

**Interfaces — Consumes:** `primaryPage` (puppeteer page) from the handshake; `readSelfIdentity`-equivalent is engine-side, so app reads member ID + slug from the same page. Existing precedent `page.cookies('https://www.linkedin.com')` at `src/linkedin/outreach.js:276`.
**Produces:**
- `capturePrimaryCookies(page)` → `{memberId, publicIdentifier, displayName, cookies}` — `page.cookies('https://www.linkedin.com')` for the jar; member ID + slug + name from the logged-in Voyager `/me` (reuse whatever `/me` read the app already has, or fetch via the page). Returns null if not logged in.
- `campaigns-client.postPrimarySession(cap)` → `POST /api/primaries/:memberId/session`.

- [ ] **Step 1: Failing test** — feed a fake `page` whose `cookies()` returns a jar with `li_at` and whose `/me` read returns member/slug/name; assert `capturePrimaryCookies` returns the shaped object; assert null when `li_at` absent.

- [ ] **Step 2: Implement `capturePrimaryCookies`.** Do NOT write the jar to disk. `ponytail:` reuse the `/me` read that already backs the account display name (`server.js:245-273` reads `/voyager/api/me`) rather than inventing a new fetch — extract it if needed.

- [ ] **Step 3: Wire into `cloud-preflight-handshake.js`** — ONLY for a personal primary (`primarySource === 'local-browser'`; a GoLogin primary needs no cookie handoff). After accept succeeds, `if (sender === 'local-browser') { const cap = await capturePrimaryCookies(primaryPage); if (cap) await postPrimarySession(cap); }` wrapped best-effort (a capture failure must not fail the handshake — log + continue).

- [ ] **Step 4: `postPrimarySession`** in `campaigns-client.js` using the existing `requestOnce('POST', '/api/primaries/'+memberId+'/session', body)`.

- [ ] **Step 5: Run tests → pass. Commit** `feat(app): capture primary session cookies and ship to engine`.

---

## Task 7 — DROPPED (exploration)

Originally "stop running the local follow-up for cloud campaigns." Not needed:
the app never enqueues cloud follow-ups. `buildFollowUpTask` is called only in
the LOCAL campaign path (`src/linkedin/auto-intro.js:212`); no cloud reconcile
(`server.js:reconcileCloud`, `src/cloud-*`) enqueues a follow-up. The engine is
the sole owner of cloud follow-ups, which Task 4 fixes. Nothing to disable.

**One verification step for the executor** (fold into Task 6's review, no code):
grep the app for `type:'follow_up'` / `enqueueFollowUpForCampaign` / `buildFollowUpTask`
callers and confirm none fire on a cloud campaign. If one is found, STOP and
escalate — the double-send assumption was wrong.

---

## Task 8 (APP): wizard primary-session hint + proxy endpoint

**Files:**
- Modify: `server.js` (add `GET /api/primary-session?primaryUrl=` proxy → engine)
- Modify: `src/campaigns-client.js` (`getPrimarySession(slug)`)
- Modify: `public/js/app.js` (primary-person-block ~2432; reuse `loadPrimaryStatusForPicker` ~616 pattern)
- Test: `tests/primary-session-proxy.test.js` (create — server route shape)

**Interfaces — Consumes:** Task 5 endpoint / status. Slug parsed from the wizard's `#primary-person-url` via the existing `primary-url-validation.mjs` / `primaryKeyFromUrl`.
**Produces:** `GET /api/primary-session?primaryUrl=` → `{state, name, capturedAt}`.

- [ ] **Step 1: Failing test** for the server proxy — valid `primaryUrl` → forwards to engine, returns its JSON; missing param → 400.

- [ ] **Step 2: Implement** the proxy — parse slug via `primaryKeyFromUrl`, call the engine `GET /api/primaries/by-slug/:slug` (built in Task 5) through `campaigns-client.getPrimarySession(slug)`, return its JSON.

- [ ] **Step 3: Wire the hint** into the primary-person block: on URL blur/change, fetch and render green `Session live — synced <ago>` or red `Needs login — follow-ups will park until <name> logs in locally`. Non-blocking (never disables launch). Mirror `loadPrimaryStatusForPicker`.

- [ ] **Step 4: Run tests → pass. Commit** `feat(app): show primary session state in the campaign wizard`.

---

## Task 9 (APP): dashboard strips + card #2 + personal nudge

**Files:**
- Modify: `public/js/app.js` — unified strip mapper (~7549-7585), `renderCloudStrip` (~6055), `_buildCloudActiveStatus` (~6202-6224) + `renderActiveCard` (~19610), and a top-level nudge on app open.
- Test: `tests/primary-session-render.test.js` (create — pure render/mapper helpers if extractable; else assert on a small pure formatter)

**Interfaces — Consumes:** `c.primarySession` (Task 5) now present on every polled cloud campaign object (flows through `campaigns-client.getCloudCampaign` verbatim).

- [ ] **Step 1: Failing test** for a pure helper `primarySessionBadge(primarySession)` → returns `{show, text, cls}` (`show:false` when live/none; red `⚠ Primary needs login — <name>` when needs_login). Keep it pure so it's unit-testable without the DOM.

- [ ] **Step 2: Implement `primarySessionBadge`** → pass.

- [ ] **Step 3: Strips** — in the unified mapper add `primarySession: c.primarySession`; in `renderCloudStrip` render the badge (repeated on every affected strip by design). Only when `needs_login`.

- [ ] **Step 4: Card #2** — in `_buildCloudActiveStatus` carry `primarySession`; in `renderActiveCard` render banner `<n> follow-ups parked — waiting for <name> to log in` when `needs_login`.

- [ ] **Step 5: Personal nudge** — on app open / periodic, if the current operator's OWN primary (match this machine's logged-in member/slug) has `needs_login` with parked > 0, show the existing top-banner component: `Your LinkedIn session expired — log in to release <n> parked follow-ups`, click → open handshake browser. Reuse the existing banner mechanism (grep for how other top-level banners render); do not build a new toast system.

- [ ] **Step 6: Run tests → pass. Commit** `feat(app): surface primary needs-login on strips, status card, and a personal nudge`.

---

## Notes for the executor

- **Order:** ENGINE first (Tasks 1→5, `cd` to the engine repo), then APP (Tasks 6, 8, 9 — **Task 7 is dropped**). App calls the new engine endpoints, so engine must land first.
- **Engine has NO `scripts.test`** (`package.json` scripts = start/dev/install-browser/login). Run test files directly: `node --test test/<file>.js`. Store/endpoint tests need local pg + redis (memory: `reference_ortus_cloud_engine_repo`) — if unavailable in the sandbox, run the PURE-logic tests (Task 3 helpers, Task 4 with injected deps) which need neither, and for the pg/redis-bound ones state exactly what couldn't run. **Never fake a green run.**
- App tests: `node --test tests/<file>.test.js`.
- **Headless question — RESOLVED, no smoke-test needed.** The VM already runs Xvfb (`DISPLAY=:99`, booted by `k8s/entrypoint.sh`) and launches every browser HEADED (`Dockerfile` `HEADLESS=false`; `k8s/10-worker-deployment.yaml`/`21-campaign-worker.yaml`: "MUST be false so Orbita renders to the Xvfb display"). The primary browser launches `headless:false` and inherits `DISPLAY` from process env → renders on the same display Orbita uses. No image change, no xvfb add.
- **Chromium binary — RESOLVED.** Base image is `mcr.microsoft.com/playwright:v1.42.0-jammy` (chromium pre-installed under `/ms-playwright`); `playwright ^1.42.0` AND `puppeteer-core ^25.2.0` are both **prod** dependencies, so `npm ci --omit=dev` keeps them and `require('playwright').chromium.executablePath()` resolves at runtime. `PRIMARY_CHROME_PATH` remains an override if the base image ever changes.
- Do NOT deploy. Engine image bump + rollout and app version bump are human steps after review.
- Bump app `package.json` + both `index.html` `?v=` in Task 9's commit per the relaunch rule.
- **What this also fixes:** cloud CC+IC follow-ups currently post as the GoLogin *sender*, not the primary (Task 4). Call this out in the final review — it changes observable behaviour for existing GoLogin-primary campaigns too, not just personal ones.
