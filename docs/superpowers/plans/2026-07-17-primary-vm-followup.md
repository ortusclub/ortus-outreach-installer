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

**ENGINE — new files**
- `campaign-store.js` (modify) — primary-registry accessors + orphaned-task reaper.
- `db/campaigns-schema.sql` (modify) — `campaign_primaries` table + reaper index.
- `primary-session.js` (create) — launch fresh chromium, inject jar, `assertPrimaryIdentity`.
- `campaign-api.js` (modify) — `POST /api/primaries/:memberId/session`; add `primarySession` to status payload.
- `campaign-runtime.js` (modify) — follow-up handler runs as primary (per-primary lock + session + gate), parks on dead session.
- `campaign-scheduler.js` (modify) — call the reaper each tick.

**APP — new/modified files**
- `src/primary-cookie-capture.js` (create) — read jar via CDP, POST to engine.
- `src/cloud-preflight-handshake.js` (modify) — capture after the primary handshake accepts.
- `src/primary-task-runner.js` (modify) — stop running the local follow-up task for cloud campaigns (accept stays).
- `src/campaigns-client.js` (modify) — `postPrimarySession`, `getPrimarySession` helpers.
- `server.js` (modify) — `GET /api/primary-session?primaryUrl=` proxy for the wizard hint.
- `public/js/app.js` (modify) — strips badge, card #2 banner, wizard hint, personal nudge.

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
- Create: `primary-session.js`
- Test: `test/primary-identity.test.js` (create — pure gate logic only)

**Interfaces — Consumes:** `readSelfIdentity(page)` from `campaign-lib/linkedin/accept-invitation.js` (returns `{name, profileUrl}`; `profileUrl` contains the publicIdentifier slug). Chromium launch pattern from `login.js:26-30` (`chromium.launchPersistentContext`) — but use a throwaway temp dir per call.
**Produces:**
- `launchPrimarySession(cookies)` → `{context, page, close()}` — fresh chromium context, `context.addCookies(toPlaywrightCookies(cookies))`, open a page.
- `identityMatches(selfProfileUrl, expectedSlug)` → bool (pure; slug extracted case-insensitively from a LinkedIn `/in/<slug>` URL).
- `assertPrimaryIdentity(page, expectedSlug)` → `{ok:true}` | `{ok:false, reason}` — calls `readSelfIdentity`, returns not-ok when logged out (no identity) or slug mismatch.

- [ ] **Step 1: Failing test** `test/primary-identity.test.js` for the PURE helpers:

```js
import { identityMatches } from '../primary-session.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('slug match is case-insensitive and ignores trailing slash/query', () => {
  assert.equal(identityMatches('https://www.linkedin.com/in/Antonio-Varlese/', 'antonio-varlese'), true);
  assert.equal(identityMatches('https://www.linkedin.com/in/antonio-varlese?x=1', 'antonio-varlese'), true);
  assert.equal(identityMatches('https://www.linkedin.com/in/someone-else', 'antonio-varlese'), false);
  assert.equal(identityMatches('', 'antonio-varlese'), false);
});
```

- [ ] **Step 2: Implement** `identityMatches` (regex `/\/in\/([^/?#]+)/i`, compare lower-cased) — run test → pass. Commit checkpoint optional.

- [ ] **Step 3: Implement `launchPrimarySession` + `assertPrimaryIdentity`.** Read `login.js:1-40` and `accept-invitation.js:117-171` first. `toPlaywrightCookies` maps the puppeteer jar shape (name/value/domain/path/expires/httpOnly/secure/sameSite) the app ships to Playwright's `addCookies` shape. `close()` disposes the context AND removes the temp dir. `ponytail:` these three helpers stay in one file; split only if a second consumer appears.

- [ ] **Step 4: Manual smoke note in report** — no unit test for the real browser launch (would need a live session); the pure gate is the tested unit. State this explicitly in the report.
- [ ] **Step 5: Commit** `feat(engine): primary session launch + injection + identity gate`.

---

## Task 4 (ENGINE): follow-up runs as primary

**Files:**
- Modify: `campaign-runtime.js` (`handleFollowUp` ~line 394; deps `sendFollowUp` ~130)
- Modify: `campaign-store.js` (per-primary Redis lock — reuse `acquireAccount`/`releaseAccount` with a `primary:<memberId>` key, or a thin `acquirePrimary(memberId)` wrapper over the same Lua)
- Test: `test/followup-as-primary.test.js` (create — inject deps, no real browser)

**Interfaces — Consumes:** Task 1 accessors, Task 3 `launchPrimarySession`/`assertPrimaryIdentity`, existing `sendInThread(page, threadUrl, body, opts)` (`campaign-lib/linkedin/thread-message.js:21`), existing lock Lua in `campaign-store.js:32`.

**Behaviour (the follow_up task handler):**
1. Resolve the campaign's primary slug from `campaign.primary_url`; look up `getPrimaryBySlug`.
2. No row, or `state='needs_login'` → **park**: reschedule the task ~30 min out, do NOT send. (Keeps it out of `claimed` limbo; resume happens when Task 6's endpoint flips state + re-queues.)
3. Acquire per-primary lock (`primary:<memberId>`); held → `{retry:true}` (existing busy semantics, 5-min retry).
4. `launchPrimarySession(row.cookies)` → `assertPrimaryIdentity(page, slug)`.
   - not-ok → `setPrimaryState(memberId,'needs_login')`, park, close, log loud (mismatch = registry bug, log louder).
   - ok → `sendInThread(...)`, mark task done, close, release lock.

- [ ] **Step 1: Failing test** with injected deps covering: (a) no primary row → parked, send never called; (b) `needs_login` → parked; (c) identity mismatch → `setPrimaryState('needs_login')` + parked + send never called; (d) happy path → send called once + task done. Assert on the injected `sendInThread` spy + `rescheduleTask`/`markTask` spies.

- [ ] **Step 2: Refactor** `handleFollowUp` to a testable core that takes its I/O as deps (match how `campaign-runtime.js` already injects `sendFollowUp`/`acceptInvite`). Read `campaign-runtime.js:384-412` first — follow the `withAccountSession` shape.

- [ ] **Step 3: Implement** the branch. `ponytail:` reuse `withAccountSession`'s acquire/finally-release structure with the primary lock key rather than writing a new lock manager.

- [ ] **Step 4: Run test → pass.**
- [ ] **Step 5: Commit** `feat(engine): send CC+IC follow-up as primary on the VM`.

---

## Task 5 (ENGINE): `primarySession` in status payload + session endpoint

**Files:**
- Modify: `campaign-api.js` (`GET /api/campaign/:id` ~139; `list` ~120; add `POST /api/primaries/:memberId/session`)
- Test: `test/primary-session-endpoint.test.js` (create)

**Interfaces — Produces:**
- Status payload gains `primarySession: {state:'live'|'needs_login'|'none', name, parked:number}` — joined via campaign's primary slug → `getPrimaryBySlug`; `parked` = count of this campaign's `follow_up` tasks currently rescheduled/pending with no send yet. `'none'` when the campaign has no primary or none has been captured yet.
- `POST /api/primaries/:memberId/session` body `{publicIdentifier, displayName, cookies}` → `upsertPrimarySession(...)` → then re-queue this member's parked follow-ups (set their `due_at=now()`), return `{ok:true, resumed:n}`.

- [ ] **Step 1: Failing test** — POST session then GET campaign status shows `primarySession.state='live'`; a `needs_login` row shows `needs_login`; POST resumes parked tasks (asserts their `due_at` moved to ≈ now).

- [ ] **Step 2: Implement** the endpoint (Bearer-guarded like siblings — `if (need(res)) return`). Resume = `UPDATE campaign_tasks SET due_at=now(), status='pending' WHERE type='follow_up' AND ... primary member matches`. Read how a follow_up task's payload identifies its primary (set in Task 4 / `campaign-autointro.js:317`) so the WHERE clause targets the right rows.

- [ ] **Step 3: Add `primarySession`** to both `GET /:id` and the explicit-column `list` payload. `list` builds objects by name — add the join there too.

- [ ] **Step 4: Run test → pass.**
- [ ] **Step 5: Commit** `feat(engine): primarySession status field + session upload endpoint`.

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

- [ ] **Step 3: Wire into `cloud-preflight-handshake.js`** — after accept succeeds, `const cap = await capturePrimaryCookies(primaryPage); if (cap) await postPrimarySession(cap);` wrapped best-effort (a capture failure must not fail the handshake — log + continue).

- [ ] **Step 4: `postPrimarySession`** in `campaigns-client.js` using the existing `requestOnce('POST', '/api/primaries/'+memberId+'/session', body)`.

- [ ] **Step 5: Run tests → pass. Commit** `feat(app): capture primary session cookies and ship to engine`.

---

## Task 7 (APP): stop running the local follow-up for cloud campaigns

**Files:**
- Modify: `src/primary-task-runner.js` (`_processOne` ~59 / follow-up branch ~75)
- Modify: `server.js` (`reconcilePrimaryHandshake` / where follow-up tasks get enqueued locally — DO NOT touch the accept path)
- Test: `tests/primary-followup-local-disabled.test.js` (create)

**Interfaces:** accept tasks (`type:'accept'`) still enqueue + run locally. Follow-up tasks for CLOUD campaigns must no longer be enqueued/run locally — the engine owns them now (Task 4).

- [ ] **Step 1: Failing test** — given a cloud campaign, the local runner enqueues/executes `accept` but NOT `follow_up`; a purely-local (non-cloud) campaign is unaffected if any such path still exists.

- [ ] **Step 2: Implement** the gate. Find where the local follow-up task is built/enqueued for cloud (grep `follow-up` in `server.js` + `src/primary-tasks.js`); skip enqueue when the campaign is cloud. Leave `buildAcceptTask` untouched.

- [ ] **Step 3: Run tests → pass. Commit** `refactor(app): engine owns cloud follow-up; local runner keeps accept only`.

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

- [ ] **Step 2: Implement** the proxy (parse slug, call engine `getPrimaryBySlug`-backed read — add a tiny engine `GET /api/primaries/by-slug/:slug` in Task 5's file if the status join isn't reusable; note this back to Task 5 if so).

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

- Tasks 1–5 are ENGINE (`cd ENGINE`), 6–9 are APP. Engine before app (app calls the new endpoints). Within engine, order 1→5. Task 8 may need a tiny engine addition (`by-slug` read) — if so, fold it into Task 5's file and note it; don't spawn a new engine task.
- Every engine task: run the engine's own test runner (read `package.json` `scripts.test` first — memory says tests need local pg/redis; if unavailable in the sandbox, the implementer runs what it can and states what it couldn't, does NOT fake a green run).
- App tests: `node --test`.
- Do NOT deploy. Deployment (engine image bump + rollout, app version bump per the relaunch rule) is a human step after review.
- Bump app `package.json` + both `index.html` `?v=` in Task 9's commit per the relaunch rule.
