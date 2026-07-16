# FG Auto-Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Follower Growth Team Launch fire itself on the cloud VM on the 1st & 15th of each month at 06:00 London, with no human clicking launch, on-by-default, controllable from a collapsed panel on the FG board.

**Architecture:** The always-on roster service (`services/fg-roster`) gains an orchestration handler. A daily GKE CronJob pokes it at 06:00 London; the handler decides (pure logic) whether this is a run day it hasn't already run, builds targets from the connections DB alone (the engine governs real limits), and dispatches through the existing `startTeamLaunchCloud` → `startCloudCampaign` path. The desktop app publishes a small config to the service and, when online, reconciles auto-pilot runs back to the FG sheet. The engine is untouched.

**Tech Stack:** Node ≥22, ESM, Express 4, `node --test` + `assert/strict`, `nodemailer` (existing dep), `@google-cloud/storage` (existing in the service), vanilla JS/CSS front-end. GKE (namespace `salesnav-scraper`).

**Spec:** `docs/superpowers/specs/2026-07-16-fg-autopilot-design.md` — read §4 before starting.

## Global Constraints

- **Off-limits files:** `src/linkedin/outreach.js`, `src/linkedin/actions.js` — never touched by this work.
- **Engine unchanged:** no edits to the `ortus-salesnav-scraper-cloud` repo except the CronJob/IAM deploy artifacts. `campaign-lib/linkedin/*` stays byte-identical to the app.
- **Never `git add`** `data/monitoring-campaign.json`, `data/fg-cloud-runs.json`, or any local `fg-autopilot*.json`. Use targeted `git add <paths>`, never `git add -A`.
- **Auto-send OFF by default (Operator rule 4):** the failure-alert email sends **only** when `ALERT_EMAIL_TO` is set; unset → logged, never sent.
- **Schedule:** run days `[1, 15]`, time fixed **06:00 Europe/London** (v1 — time not editable from the app). Timezone string exactly `"Europe/London"`.
- **Shared token:** reuse `FG_ROSTER_TOKEN` (baked in `src/fg-roster-url.js`) for all new service routes. No new public secret.
- **Testing:** `node --test tests/<file>.test.js`, `import { test } from 'node:test'; import assert from 'node:assert/strict';`. Pure-helper unit tests; UI is manual-verify only.
- **On-by-default:** ships `enabled: true`, `days: [1,15]`. First 1st/15th after rollout fires automatically.
- **No new DMG / no GitHub push** as part of this work unless separately requested — land on a branch only.
- **Version bump** `package.json` + both `?v=` query strings in `public/index.html` on the first UI-touching commit, per repo convention.

---

### Task 1: Shared decision module `src/fg-autopilot.js` (pure)

The testable core. One module, imported by both the app and the service, so schedule logic can never drift between "what the UI says the next run is" and "what actually fires."

**Files:**
- Create: `src/fg-autopilot.js`
- Test: `tests/fg-autopilot.test.js`

**Interfaces:**
- Produces:
  - `cycleKey(date: Date, tz = 'Europe/London') → string` — the London calendar day as `"YYYY-MM-DD"`.
  - `isRunDay(date: Date, days = [1,15], tz = 'Europe/London') → boolean` — is the London day-of-month in `days`.
  - `nextRun(now: Date, { days = [1,15], enabled = true } = {}, tz = 'Europe/London') → Date | null` — next fire instant (a day in `days` at 06:00 London strictly after `now`), or `null` if `!enabled`.
  - `shouldFire(now: Date, config, ranCycleKeys: string[], tz = 'Europe/London') → { fire: boolean, reason: string, cycleKey: string }` — `reason ∈ {disabled, no-pairs, not-a-run-day, already-ran, fire}`.
  - `fgCriteria(keywords: string[]) → { jobTitles, companies, geo }` — the criteria shape `buildFgTargets` expects (no hidden default; defaulting happens in `buildAutopilotConfig`).
  - `buildAutopilotConfig({ pairs, keywords, enabled = true, days = [1,15], marketerDefaults = [], publishedBy = '', publishedAt }) → config` — drops `local-browser` pairs; empty `keywords` falls back to `marketerDefaults`.

- [ ] **Step 1: Write the failing tests**

Create `tests/fg-autopilot.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleKey, isRunDay, nextRun, shouldFire, fgCriteria, buildAutopilotConfig,
} from '../src/fg-autopilot.js';

// --- cycleKey uses the LONDON calendar day, not UTC ---
test('cycleKey returns the London calendar day', () => {
  // 2026-08-01T00:30:00Z — London is BST (UTC+1) in August, so it's already 01:30 on Aug 1.
  assert.equal(cycleKey(new Date('2026-08-01T00:30:00Z')), '2026-08-01');
});
test('cycleKey rolls to the next London day when UTC is still the previous day', () => {
  // 2026-08-14T23:30:00Z — BST → 2026-08-15T00:30 London → the 15th.
  assert.equal(cycleKey(new Date('2026-08-14T23:30:00Z')), '2026-08-15');
});

// --- isRunDay ---
test('isRunDay true on the 1st and 15th, false otherwise', () => {
  assert.equal(isRunDay(new Date('2026-08-01T06:00:00+01:00')), true);
  assert.equal(isRunDay(new Date('2026-08-15T06:00:00+01:00')), true);
  assert.equal(isRunDay(new Date('2026-08-02T06:00:00+01:00')), false);
});
test('isRunDay respects a custom days array', () => {
  assert.equal(isRunDay(new Date('2026-08-20T06:00:00+01:00'), [1, 20]), true);
  assert.equal(isRunDay(new Date('2026-08-15T06:00:00+01:00'), [1, 20]), false);
});

// --- nextRun ---
test('nextRun returns null when disabled', () => {
  assert.equal(nextRun(new Date('2026-07-16T09:00:00Z'), { enabled: false }), null);
});
test('nextRun from mid-month points to the 1st of next month at 06:00 London', () => {
  const d = nextRun(new Date('2026-07-16T09:00:00Z'), { days: [1, 15] });
  assert.equal(cycleKey(d), '2026-08-01');
  // 06:00 London on 2026-08-01 (BST) === 05:00Z
  assert.equal(d.toISOString(), '2026-08-01T05:00:00.000Z');
});
test('nextRun on a run day before 06:00 returns today; after 06:00 returns the next run day', () => {
  const before = nextRun(new Date('2026-08-01T03:00:00Z'), { days: [1, 15] }); // 04:00 London, before 06:00
  assert.equal(cycleKey(before), '2026-08-01');
  const after = nextRun(new Date('2026-08-01T09:00:00Z'), { days: [1, 15] }); // 10:00 London, after 06:00
  assert.equal(cycleKey(after), '2026-08-15');
});

// --- shouldFire truth table ---
const cfg = { enabled: true, days: [1, 15], pairs: [{ profileId: 'p1' }], keywords: ['x'] };
test('shouldFire: disabled', () => {
  assert.equal(shouldFire(new Date('2026-08-01T06:00:00+01:00'), { ...cfg, enabled: false }, []).reason, 'disabled');
});
test('shouldFire: no pairs', () => {
  assert.equal(shouldFire(new Date('2026-08-01T06:00:00+01:00'), { ...cfg, pairs: [] }, []).reason, 'no-pairs');
});
test('shouldFire: not a run day', () => {
  assert.equal(shouldFire(new Date('2026-08-02T06:00:00+01:00'), cfg, []).reason, 'not-a-run-day');
});
test('shouldFire: already ran this cycle', () => {
  const r = shouldFire(new Date('2026-08-01T06:00:00+01:00'), cfg, ['2026-08-01']);
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'already-ran');
});
test('shouldFire: fire', () => {
  const r = shouldFire(new Date('2026-08-01T06:00:00+01:00'), cfg, ['2026-07-15']);
  assert.equal(r.fire, true);
  assert.equal(r.reason, 'fire');
  assert.equal(r.cycleKey, '2026-08-01');
});

// --- fgCriteria ---
test('fgCriteria wraps keywords into jobTitles + empty companies/geo', () => {
  assert.deepEqual(fgCriteria(['marketing', 'founder']), { jobTitles: ['marketing', 'founder'], companies: [], geo: [] });
});

// --- buildAutopilotConfig ---
test('buildAutopilotConfig drops local-browser pairs and defaults keywords', () => {
  const cfg2 = buildAutopilotConfig({
    pairs: [
      { operator: 'o', account: 'a@x', profileId: 'gl-1', operatorName: 'O' },
      { operator: 'o2', account: 'b@x', profileId: 'local-browser', operatorName: 'O2' },
    ],
    keywords: [],
    marketerDefaults: ['marketing'],
    publishedBy: 'ortus@x',
    publishedAt: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(cfg2.pairs.length, 1);
  assert.equal(cfg2.pairs[0].profileId, 'gl-1');
  assert.deepEqual(cfg2.keywords, ['marketing']);
  assert.equal(cfg2.enabled, true);
  assert.deepEqual(cfg2.days, [1, 15]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/fg-autopilot.test.js`
Expected: FAIL — `Cannot find module '../src/fg-autopilot.js'`.

- [ ] **Step 3: Implement `src/fg-autopilot.js`**

```js
// Pure schedule/decision logic for FG Auto-Pilot. No I/O — imported by both the
// desktop app (to render "next run") and the cloud roster service (to decide
// firing), so the two can never disagree. Timezone-correct via Intl.
const TZ = 'Europe/London';
const RUN_HOUR = 6; // 06:00 local — fixed in v1

// London date/time parts for an instant, as numbers.
function parts(date, tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const o = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  if (o.hour === 24) o.hour = 0; // some engines emit 24 for midnight
  return o; // { year, month, day, hour, minute }
}

export function cycleKey(date, tz = TZ) {
  const p = parts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function isRunDay(date, days = [1, 15], tz = TZ) {
  return days.includes(parts(date, tz).day);
}

// Build the UTC instant of RUN_HOUR:00 local on the given local Y-M-D. Corrects
// for the tz offset (incl. DST) with a single guess-and-fix pass.
function localRunInstant(year, month, day, tz = TZ) {
  const guess = Date.UTC(year, month - 1, day, RUN_HOUR, 0);
  const p = parts(new Date(guess), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = asUtc - guess; // ms the zone is ahead of UTC at that instant
  return new Date(guess - offset);
}

export function nextRun(now, { days = [1, 15], enabled = true } = {}, tz = TZ) {
  if (!enabled) return null;
  for (let i = 0; i < 400; i++) {
    const probe = new Date(now.getTime() + i * 86400000);
    const p = parts(probe, tz);
    if (!days.includes(p.day)) continue;
    const instant = localRunInstant(p.year, p.month, p.day, tz);
    if (instant.getTime() > now.getTime()) return instant;
  }
  return null; // unreachable for sane inputs
}

export function shouldFire(now, config, ranCycleKeys = [], tz = TZ) {
  const key = cycleKey(now, tz);
  const c = config || {};
  if (!c.enabled) return { fire: false, reason: 'disabled', cycleKey: key };
  if (!Array.isArray(c.pairs) || !c.pairs.length) return { fire: false, reason: 'no-pairs', cycleKey: key };
  if (!isRunDay(now, c.days || [1, 15], tz)) return { fire: false, reason: 'not-a-run-day', cycleKey: key };
  if (ranCycleKeys.includes(key)) return { fire: false, reason: 'already-ran', cycleKey: key };
  return { fire: true, reason: 'fire', cycleKey: key };
}

export function fgCriteria(keywords = []) {
  return { jobTitles: Array.isArray(keywords) ? keywords : [], companies: [], geo: [] };
}

export function buildAutopilotConfig({
  pairs = [], keywords = [], enabled = true, days = [1, 15],
  marketerDefaults = [], publishedBy = '', publishedAt,
} = {}) {
  const cloudPairs = (pairs || [])
    .filter((p) => p && p.operator && p.account && p.profileId && p.profileId !== 'local-browser')
    .map((p) => ({ operator: p.operator, operatorName: p.operatorName || '', account: p.account, profileId: p.profileId }));
  const kw = Array.isArray(keywords) && keywords.length ? keywords : marketerDefaults;
  return { enabled, days, keywords: kw, pairs: cloudPairs, publishedBy, publishedAt };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fg-autopilot.test.js`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fg-autopilot.js tests/fg-autopilot.test.js
git commit -m "feat(fg-autopilot): shared pure schedule/config module"
```

---

### Task 2: Failure-alert mailer `services/fg-roster/mailer.js`

Sends the failure email, gated OFF unless `ALERT_EMAIL_TO` is set (Operator rule 4).

**Files:**
- Create: `services/fg-roster/mailer.js`
- Test: `tests/fg-roster-mailer.test.js`

**Interfaces:**
- Produces: `makeMailer({ to, from, transport }) → { sendAlert(subject: string, body: string): Promise<{sent, reason?}> }`.
  - `to` defaults to `process.env.ALERT_EMAIL_TO` (comma-separated). Falsy/empty → every `sendAlert` is a no-op returning `{ sent: false, reason: 'no-recipients' }`.
  - `transport` is injectable (a nodemailer-like object with `sendMail`). When omitted and `to` is set, build one from `ALERT_SMTP_HOST/PORT/USER/PASS`.

- [ ] **Step 1: Write the failing tests**

Create `tests/fg-roster-mailer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMailer } from '../services/fg-roster/mailer.js';

test('sendAlert is a no-op when no recipients configured', async () => {
  let called = false;
  const transport = { sendMail: async () => { called = true; } };
  const mailer = makeMailer({ to: '', transport });
  const r = await mailer.sendAlert('subj', 'body');
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no-recipients');
  assert.equal(called, false);
});

test('sendAlert sends to each recipient when configured', async () => {
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return { messageId: 'x' }; } };
  const mailer = makeMailer({ to: 'a@x.com, b@x.com', from: 'fg@x.com', transport });
  const r = await mailer.sendAlert('Run failed', 'details');
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'a@x.com, b@x.com');
  assert.equal(sent[0].subject, 'Run failed');
  assert.match(sent[0].text, /details/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/fg-roster-mailer.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `services/fg-roster/mailer.js`**

```js
// Failure-alert email for FG Auto-Pilot. OFF by default (Operator rule 4):
// no recipients → no send, ever. nodemailer is already a repo dependency.
import nodemailer from 'nodemailer';

export function makeMailer({
  to = process.env.ALERT_EMAIL_TO || '',
  from = process.env.ALERT_EMAIL_FROM || 'fg-autopilot@ortusclub.com',
  transport,
} = {}) {
  const recipients = String(to).trim();
  const tx = transport || (recipients ? nodemailer.createTransport({
    host: process.env.ALERT_SMTP_HOST,
    port: Number(process.env.ALERT_SMTP_PORT || 587),
    auth: process.env.ALERT_SMTP_USER
      ? { user: process.env.ALERT_SMTP_USER, pass: process.env.ALERT_SMTP_PASS }
      : undefined,
  }) : null);

  return {
    async sendAlert(subject, body) {
      if (!recipients || !tx) return { sent: false, reason: 'no-recipients' };
      await tx.sendMail({ from, to: recipients, subject, text: body });
      return { sent: true };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fg-roster-mailer.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/fg-roster/mailer.js tests/fg-roster-mailer.test.js
git commit -m "feat(fg-autopilot): failure-alert mailer, off by default"
```

---

### Task 3: Orchestration handler `services/fg-roster/autopilot.js`

Decides + dispatches one run. Pure of real I/O — engine, run-store, mailer, and config are all injected, so it's fully unit-testable.

**Files:**
- Create: `services/fg-roster/autopilot.js`
- Test: `tests/fg-roster-autopilot.test.js`

**Interfaces:**
- Consumes: `shouldFire`, `fgCriteria`, `cycleKey` (Task 1); `startTeamLaunchCloud`, `makeRunStore` (`src/connections/fg-cloud-launch.js`); `makeMailer` (Task 2); `searchService.buildFgTargets`.
- Produces: `makeAutopilotHandler(deps) → { run({ force = false }): Promise<result> }` where `result` is one of `{ skipped: true, reason }`, `{ dispatched: true, cloudId, cycleKey }`, `{ failed: true, error, cycleKey }`.
  - `deps`: `{ searchService, startCloud, queueInvites, runStore, loadConfig, saveRuns, sendAlert, now, log, inviteUrl, monthlyBudget, tz }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/fg-roster-autopilot.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAutopilotHandler } from '../services/fg-roster/autopilot.js';

const RUN_DAY = new Date('2026-08-01T06:00:00+01:00'); // London run day, 06:00
const cfg = () => ({
  enabled: true, days: [1, 15], keywords: ['marketing'],
  pairs: [{ operator: 'op@x', operatorName: 'Op', account: 'a@x.com', profileId: 'gl-1' }],
});

function memRunStore(initial = []) {
  let runs = [...initial];
  return {
    load: () => runs,
    save: (r) => { runs = r; },
    add: (run) => { runs.push(run); },
    update: (cloudId, patch) => {
      const i = runs.findIndex((r) => r.cloudId === cloudId);
      if (i < 0) return false; runs[i] = { ...runs[i], ...patch }; return true;
    },
    _all: () => runs,
  };
}

// Minimal searchService stub: buildFgTargets returns 2 rows.
const searchService = {
  buildFgTargets: () => ({
    rows: [
      ['Jane', 'https://linkedin.com/in/jane', '111', 'Acme', 'CMO', '', '', '', '', '', '', '', ''],
      ['John', 'https://linkedin.com/in/john', '222', 'Beta', 'CEO', '', '', '', '', '', '', '', ''],
    ],
    count: 2, matched: 2, eligible: 2,
  }),
};

function base(overrides = {}) {
  const runStore = overrides.runStore || memRunStore();
  return {
    searchService,
    startCloud: overrides.startCloud || (async () => ({ id: 'cloud-123' })),
    queueInvites: async () => {},
    runStore,
    loadConfig: overrides.loadConfig || (() => cfg()),
    saveRuns: () => {},
    sendAlert: overrides.sendAlert || (async () => ({ sent: true })),
    now: () => RUN_DAY.toISOString(),
    log: () => {},
    inviteUrl: 'https://linkedin.com/company/ortus',
    monthlyBudget: 30,
    tz: 'Europe/London',
    _now: RUN_DAY,
    ...overrides,
  };
}

test('fires on a run day: dispatches once + records with cycleKey', async () => {
  const runStore = memRunStore();
  let dispatched = 0;
  const h = makeAutopilotHandler(base({ runStore, startCloud: async () => { dispatched++; return { id: 'cloud-123' }; }, _now: RUN_DAY }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.dispatched, true);
  assert.equal(r.cloudId, 'cloud-123');
  assert.equal(dispatched, 1);
  const rec = runStore._all().find((x) => x.cloudId === 'cloud-123');
  assert.equal(rec.cycleKey, '2026-08-01');
});

test('does not fire twice for the same cycle', async () => {
  const runStore = memRunStore([{ cloudId: 'old', cycleKey: '2026-08-01', status: 'dispatched' }]);
  let dispatched = 0;
  const h = makeAutopilotHandler(base({ runStore, startCloud: async () => { dispatched++; return { id: 'x' }; } }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'already-ran');
  assert.equal(dispatched, 0);
});

test('disabled config → skip, no dispatch', async () => {
  let dispatched = 0;
  const h = makeAutopilotHandler(base({ loadConfig: () => ({ ...cfg(), enabled: false }), startCloud: async () => { dispatched++; return { id: 'x' }; } }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'disabled');
  assert.equal(dispatched, 0);
});

test('force ignores the gate and dispatches even off a run day', async () => {
  const OFF_DAY = new Date('2026-08-02T09:00:00+01:00');
  let dispatched = 0;
  const h = makeAutopilotHandler(base({ startCloud: async () => { dispatched++; return { id: 'm1' }; }, now: () => OFF_DAY.toISOString() }));
  const r = await h.run({ force: true, nowDate: OFF_DAY });
  assert.equal(r.dispatched, true);
  assert.equal(dispatched, 1);
  assert.match(r.cycleKey, /-manual-/);
});

test('dispatch failure → failed record + one alert', async () => {
  const runStore = memRunStore();
  let alerts = 0;
  const h = makeAutopilotHandler(base({
    runStore,
    startCloud: async () => ({ error: 'engine down' }),
    sendAlert: async () => { alerts++; return { sent: true }; },
  }));
  const r = await h.run({ nowDate: RUN_DAY });
  assert.equal(r.failed, true);
  assert.match(r.error, /engine down/);
  assert.equal(alerts, 1);
  assert.equal(runStore._all().some((x) => x.status === 'failed' && x.cycleKey === '2026-08-01'), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/fg-roster-autopilot.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `services/fg-roster/autopilot.js`**

```js
// FG Auto-Pilot orchestration — decide + dispatch one run. All real I/O is
// injected, so this is unit-testable with no engine, no filesystem, no HTTP.
// Targets come from the connections DB alone (alreadyInvited:[], budget:Infinity);
// the engine caps to live invite-credit count and skips already-following/invited.
import { shouldFire, cycleKey, fgCriteria } from '../../src/fg-autopilot.js';
import { startTeamLaunchCloud } from '../../src/connections/fg-cloud-launch.js';

export function makeAutopilotHandler(deps) {
  const {
    searchService, startCloud, queueInvites, runStore, loadConfig, saveRuns,
    sendAlert, now, log, inviteUrl, monthlyBudget, tz = 'Europe/London',
  } = deps;

  return {
    async run({ force = false, nowDate } = {}) {
      const nd = nowDate || new Date(now());
      const config = loadConfig() || {};
      const ranKeys = (runStore.load() || []).map((r) => r.cycleKey).filter(Boolean);

      let key;
      if (force) {
        // Manual "Run now": bypass the gate, but still need pairs to do anything.
        if (!Array.isArray(config.pairs) || !config.pairs.length) return { skipped: true, reason: 'no-pairs' };
        const manualN = ranKeys.filter((k) => k.startsWith(cycleKey(nd, tz) + '-manual-')).length + 1;
        key = `${cycleKey(nd, tz)}-manual-${manualN}`;
      } else {
        const decision = shouldFire(nd, config, ranKeys, tz);
        if (!decision.fire) return { skipped: true, reason: decision.reason };
        key = decision.cycleKey;
      }

      const month = cycleKey(nd, tz).slice(0, 7); // YYYY-MM
      const buildTargets = (pair) => {
        const out = searchService.buildFgTargets(fgCriteria(config.keywords || []), {
          operator: pair.operator, operatorName: pair.operatorName,
          account: pair.account, month, alreadyInvited: [], budget: Infinity,
        });
        let reason = '';
        if (!out.count) reason = out.matched === 0 ? 'no connections match these roles' : 'no eligible targets';
        return { rows: out.rows, count: out.count, reason };
      };

      let result;
      try {
        result = await startTeamLaunchCloud(config.pairs, {
          buildTargets,
          startCloud,
          queueInvites: queueInvites || (async () => {}),
          runStore,
          now,
          log: log || (() => {}),
          month,
          owner: config.publishedBy || '',
          name: `Team Follower Growth · ${month} · auto`,
          inviteUrl,
          monthlyBudget,
        });
      } catch (e) {
        result = { error: e.message };
      }

      if (result.error) {
        runStore.add({ cycleKey: key, status: 'failed', error: result.error, dispatchedAt: now(), source: force ? 'manual' : 'auto' });
        saveRuns();
        try { await sendAlert(`⚠️ FG Auto-Pilot run failed — ${key}`, `Cycle ${key}\nStage: dispatch\nError: ${result.error}\n\nFix, then use "Run now" from the FG board.`); }
        catch (_) { /* alerting must never mask the original failure */ }
        return { failed: true, error: result.error, cycleKey: key };
      }

      // startTeamLaunchCloud already added a {cloudId,...} record; tag it with the cycle key + source.
      runStore.update(result.cloudId, { cycleKey: key, source: force ? 'manual' : 'auto' });
      saveRuns();
      return { dispatched: true, cloudId: result.cloudId, cycleKey: key };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fg-roster-autopilot.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add services/fg-roster/autopilot.js tests/fg-roster-autopilot.test.js
git commit -m "feat(fg-autopilot): orchestration handler (decide + dispatch one run)"
```

---

### Task 4: Service routes + entry wiring

Expose the handler and config over HTTP, wire the real GCS-backed config store + run store + mailer + engine client in the service entrypoint.

**Files:**
- Modify: `services/fg-roster/app.js` (add three routes)
- Modify: `services/fg-roster/server.js` (wire deps)
- Create: `services/fg-roster/config-store.js` (local file + GCS mirror)
- Test: `tests/fg-roster-autopilot-routes.test.js`

**Interfaces:**
- Consumes: `makeAutopilotHandler` (Task 3), `buildAutopilotConfig`-shaped config, `makeRunStore` (`src/connections/fg-cloud-launch.js`).
- Produces (routes, all mounted under `/fg-roster`, all Bearer-auth except none new is public):
  - `POST /admin/autopilot-config` — body = config JSON → persists (local + GCS) → `{ ok: true }`.
  - `GET /admin/autopilot` — `{ config, runs }` (config or `null`; runs = run-store contents).
  - `POST /admin/autopilot` — body `{}` or `{ force: true }` → runs the handler → the handler result JSON.
- Produces: `makeConfigStore({ path, putObject }) → { load(): config|null, save(config): void }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/fg-roster-autopilot-routes.test.js` (mirrors the listen+fetch style of `tests/fg-roster-app.test.js`):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from '../services/fg-roster/app.js';

const TOKEN = 'tok';
function harness(handlerResult = { dispatched: true, cloudId: 'c1', cycleKey: '2026-08-01' }) {
  let saved = null;
  const store = { load: () => saved, save: (c) => { saved = c; } };
  const runStore = { load: () => [{ cloudId: 'c1', cycleKey: '2026-08-01', status: 'dispatched' }] };
  const autopilot = { run: async (opts) => ({ ...handlerResult, _opts: opts }) };
  const app = makeApp({
    impl: {}, token: TOKEN, isReady: () => true, onRefresh: async () => {},
    autopilot, configStore: store, runStore,
  });
  return { app, store: () => saved };
}
async function listen(app) {
  const srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}/fg-roster`, close: () => srv.close() };
}
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

test('POST /admin/autopilot-config persists and GET returns it', async () => {
  const h = harness();
  const { base, close } = await listen(h.app);
  try {
    const cfg = { enabled: true, days: [1, 15], pairs: [{ profileId: 'p1' }], keywords: ['x'] };
    const put = await fetch(base + '/admin/autopilot-config', { method: 'POST', headers: H, body: JSON.stringify(cfg) });
    assert.equal(put.status, 200);
    assert.deepEqual(h.store().pairs, cfg.pairs);
    const get = await fetch(base + '/admin/autopilot', { headers: { authorization: `Bearer ${TOKEN}` } });
    const j = await get.json();
    assert.equal(j.config.enabled, true);
    assert.equal(j.runs.length, 1);
  } finally { close(); }
});

test('POST /admin/autopilot runs the handler and returns its result', async () => {
  const h = harness();
  const { base, close } = await listen(h.app);
  try {
    const r = await fetch(base + '/admin/autopilot', { method: 'POST', headers: H, body: JSON.stringify({ force: true }) });
    const j = await r.json();
    assert.equal(j.dispatched, true);
    assert.equal(j._opts.force, true);
  } finally { close(); }
});

test('autopilot routes require the bearer token', async () => {
  const h = harness();
  const { base, close } = await listen(h.app);
  try {
    const r = await fetch(base + '/admin/autopilot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
  } finally { close(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/fg-roster-autopilot-routes.test.js`
Expected: FAIL — `makeApp` ignores the new options; routes 404/401 mismatch.

- [ ] **Step 3: Add the routes in `services/fg-roster/app.js`**

Change the signature and add routes (keep existing `/health`, `/rpc`, `/admin/refresh` untouched):

```js
export function makeApp({ impl, token, isReady, onRefresh, autopilot, configStore, runStore }) {
```

Add, before `app.use('/fg-roster', router);`:

```js
  router.post('/admin/autopilot-config', auth, (req, res) => {
    try { configStore.save(req.body || {}); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/autopilot', auth, (_req, res) => {
    res.json({ config: configStore.load(), runs: runStore.load() });
  });

  router.post('/admin/autopilot', auth, async (req, res) => {
    try { res.json(await autopilot.run({ force: !!(req.body && req.body.force) })); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
```

- [ ] **Step 4: Implement `services/fg-roster/config-store.js`**

```js
// Persist the FG Auto-Pilot config locally (for the scheduler to read) AND to GCS
// (so it survives pod restarts — boot pullDb downloads it back). Local read is the
// source the handler uses each run.
import fs from 'node:fs';

export function makeConfigStore({ path, putObject }) {
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
    },
    save(config) {
      const buf = JSON.stringify(config, null, 2);
      const tmp = path + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path);
      if (putObject) { Promise.resolve(putObject('fg-autopilot.json', buf)).catch(() => {}); }
    },
  };
}
```

- [ ] **Step 5: Wire the entry `services/fg-roster/server.js`**

Add a GCS `putObject` (uses the same `@google-cloud/storage` already imported for pulls), build the run store + config store + mailer + handler, and pass them to `makeApp`. Replace the file body's tail with:

```js
import path from 'node:path';
import os from 'node:os';
import { pullDb } from './pull-db.js';
import { Storage } from '@google-cloud/storage';
import { makeRunStore } from '../../src/connections/fg-cloud-launch.js';
import { startCloudCampaign } from '../../src/campaigns-client.js';
import { makeConfigStore } from './config-store.js';
import { makeMailer } from './mailer.js';
import { makeAutopilotHandler } from './autopilot.js';

const DEST = process.env.CONNECTIONS_DIR || path.join(os.tmpdir(), 'fg-connections');
process.env.CONNECTIONS_DB_DIR = DEST;

const { makeApp } = await import('./app.js');
const searchService = await import('../../src/connections/search-service.js');

const BUCKET = process.env.FG_ROSTER_BUCKET || 'ortus-fg-connections-db';
const storage = new Storage();
const putObject = (name, buf) => storage.bucket(BUCKET).file(name).save(buf, { resumable: false });

const configStore = makeConfigStore({ path: path.join(DEST, 'fg-autopilot.json'), putObject });
const runStore = makeRunStore(path.join(DEST, 'fg-autopilot-runs.json'));
const saveRuns = () => { try { putObject('fg-autopilot-runs.json', JSON.stringify(runStore.load(), null, 2)); } catch (_) {} };
const mailer = makeMailer({});

const autopilot = makeAutopilotHandler({
  searchService,
  startCloud: (payload) => startCloudCampaign(payload),
  queueInvites: async () => {},
  runStore,
  loadConfig: () => configStore.load(),
  saveRuns,
  sendAlert: (s, b) => mailer.sendAlert(s, b),
  now: () => new Date().toISOString(),
  log: (m) => console.log(`[fg-autopilot] ${m}`),
  inviteUrl: process.env.ORTUS_PAGE_INVITE_URL || '',
  monthlyBudget: Number(process.env.FG_DEFAULT_MONTHLY_ALLOWANCE || 30),
});

let ready = false;
async function refresh() { await pullDb({ destDir: DEST }); ready = true; }

const TOKEN = process.env.FG_ROSTER_TOKEN || 'ortus2026scraper';
const PORT = Number(process.env.PORT || 8080);

const app = makeApp({ impl: searchService, token: TOKEN, isReady: () => ready, onRefresh: refresh, autopilot, configStore, runStore });
app.listen(PORT, () => console.log(`[fg-roster] listening on :${PORT}`));

refresh().catch((e) => console.error('[fg-roster] initial DB pull failed (will 503 until /admin/refresh):', e.message));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/fg-roster-autopilot-routes.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full service test set for no regressions**

Run: `node --test tests/fg-roster-app.test.js tests/fg-roster-autopilot.test.js tests/fg-roster-autopilot-routes.test.js tests/fg-roster-mailer.test.js`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add services/fg-roster/app.js services/fg-roster/server.js services/fg-roster/config-store.js tests/fg-roster-autopilot-routes.test.js
git commit -m "feat(fg-autopilot): service routes + GCS-backed config/run stores + entry wiring"
```

---

### Task 5: GKE CronJob + secret/IAM deploy artifacts

The daily heartbeat that pokes the service, plus the new secret keys and the IAM grant. No unit test — verified by `kubectl apply --dry-run=server` and documented in the runbook.

**Files:**
- Create: `k8s/fg-roster/cronjob.yaml`
- Modify: `k8s/fg-roster/secret.example.yaml` (document new keys)
- Modify: `docs/superpowers/plans/2026-07-16-fg-roster-runbook.md` (append an Auto-Pilot deploy section)

- [ ] **Step 1: Create `k8s/fg-roster/cronjob.yaml`**

```yaml
# k8s/fg-roster/cronjob.yaml — daily 06:00 Europe/London heartbeat that pokes the
# roster service to run FG Auto-Pilot. The service decides (via fg-autopilot.json)
# whether today is actually a run day, so the schedule of substance is DATA, not
# this cron expression. A daily no-op poke is negligible.
apiVersion: batch/v1
kind: CronJob
metadata:
  name: fg-autopilot
  namespace: salesnav-scraper
spec:
  schedule: "0 6 * * *"
  timeZone: "Europe/London"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 3600
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: poke
              image: curlimages/curl:8.10.1
              env:
                - name: FG_ROSTER_TOKEN
                  valueFrom: { secretKeyRef: { name: fg-roster, key: token } }
              command: ["sh", "-c"]
              args:
                - >-
                  curl -fsS -X POST
                  -H "Authorization: Bearer $FG_ROSTER_TOKEN"
                  -H "content-type: application/json"
                  -d '{}'
                  http://fg-roster.salesnav-scraper.svc.cluster.local/fg-roster/admin/autopilot
```

- [ ] **Step 2: Document the new secret keys in `k8s/fg-roster/secret.example.yaml`**

Add these keys alongside the existing `token` (the real `secret.yaml` stays gitignored):

```yaml
stringData:
  token: "REPLACE_WITH_FG_ROSTER_TOKEN"
  # FG Auto-Pilot failure alerts (Operator rule 4: UNSET = never sends)
  ALERT_EMAIL_TO: "antonio@ortusclub.com,antoniov@ortusclub.com"
  ALERT_EMAIL_FROM: "fg-autopilot@ortusclub.com"
  ALERT_SMTP_HOST: "REPLACE"
  ALERT_SMTP_PORT: "587"
  ALERT_SMTP_USER: "REPLACE"
  ALERT_SMTP_PASS: "REPLACE"
```

Then add the alert env to the Deployment's container (`k8s/fg-roster/deployment.yaml`) via `envFrom` so the service picks them up:

```yaml
          envFrom:
            - secretRef: { name: fg-roster }
```

(Place it under the existing `env:` block on the `fg-roster` container. `envFrom` loads every key; the explicit `token`/`FG_ROSTER_BUCKET`/`CONNECTIONS_DIR` entries can remain.)

- [ ] **Step 3: Append the Auto-Pilot deploy section to the runbook**

Append to `docs/superpowers/plans/2026-07-16-fg-roster-runbook.md`:

````markdown
## FG Auto-Pilot add-on (2026-07-16)

1. **IAM — grant the service GCS write** (was read-only):
   ```bash
   gcloud storage buckets add-iam-policy-binding gs://ortus-fg-connections-db \
     --member="serviceAccount:fg-roster-reader@salesnav-scraper-prod.iam.gserviceaccount.com" \
     --role="roles/storage.objectUser"
   ```
2. **Secret — add SMTP + recipients** to `k8s/fg-roster/secret.yaml` (gitignored) per `secret.example.yaml`, then `kubectl apply -f k8s/fg-roster/secret.yaml`.
3. **Rebuild + roll the image** (now includes `services/fg-roster/{autopilot,mailer,config-store}.js` + `src/fg-autopilot.js`): rebuild via `services/fg-roster/cloudbuild.yaml`, bump the image tag, `kubectl set image`/`apply` the Deployment (with the new `envFrom`).
4. **CronJob:** `kubectl apply -f k8s/fg-roster/cronjob.yaml`.
5. **Verify:** `kubectl create job --from=cronjob/fg-autopilot fg-autopilot-manual -n salesnav-scraper` then `kubectl logs job/fg-autopilot-manual -n salesnav-scraper` — expect a JSON `{"skipped":true,"reason":"not-a-run-day"}` (unless run on the 1st/15th) or `no-pairs` before the app has published a config.
````

- [ ] **Step 4: Validate the manifests**

Run: `kubectl apply --dry-run=client -f k8s/fg-roster/cronjob.yaml`
Expected: `cronjob.batch/fg-autopilot created (dry run)` with no schema errors. (Server dry-run + real apply happen at deploy, gated on explicit user approval per the prod-apply rule.)

- [ ] **Step 5: Commit**

```bash
git add k8s/fg-roster/cronjob.yaml k8s/fg-roster/secret.example.yaml k8s/fg-roster/deployment.yaml docs/superpowers/plans/2026-07-16-fg-roster-runbook.md
git commit -m "feat(fg-autopilot): GKE CronJob heartbeat + secret/IAM deploy artifacts"
```

---

### Task 6: App-side config publisher

The desktop app publishes the current FG team config to the service whenever the FG board is opened or its pairings/keywords/toggle/schedule change.

**Files:**
- Modify: `server.js` (add a publish helper + a publish route the front-end calls)
- Test: `tests/fg-autopilot-publish.test.js`

**Interfaces:**
- Consumes: `buildAutopilotConfig` (Task 1), `FG_ROSTER_URL`/`FG_ROSTER_TOKEN` (`src/fg-roster-url.js`).
- Produces:
  - `buildAutopilotConfig` is exercised app-side; a thin `publishAutopilotConfig(config, { fetchImpl })` POSTs to `${FG_ROSTER_URL}/admin/autopilot-config`.
  - Route `POST /api/fg/autopilot/publish` — body `{ pairs, keywords, enabled, days }` → builds config, POSTs to the service → `{ ok: true }` or `{ error }`.

- [ ] **Step 1: Write the failing test**

Create `tests/fg-autopilot-publish.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishAutopilotConfig } from '../src/fg-autopilot-publish.js';

test('publishAutopilotConfig POSTs the config with the bearer token', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ ok: true }) }; };
  const r = await publishAutopilotConfig({ enabled: true, pairs: [] }, {
    fetchImpl, rosterUrl: 'https://svc/fg-roster', rosterToken: 'tok',
  });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://svc/fg-roster/admin/autopilot-config');
  assert.equal(seen.opts.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen.opts.body).pairs, []);
});

test('publishAutopilotConfig surfaces a non-ok response as an error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const r = await publishAutopilotConfig({}, { fetchImpl, rosterUrl: 'https://svc/fg-roster', rosterToken: 't' });
  assert.match(r.error, /500/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/fg-autopilot-publish.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fg-autopilot-publish.js`**

```js
// Thin publisher: POST the FG Auto-Pilot config to the central roster service.
// Any operator can call it — needs only the baked token, no gcloud.
import { FG_ROSTER_URL, FG_ROSTER_TOKEN } from './fg-roster-url.js';

export async function publishAutopilotConfig(config, {
  fetchImpl = fetch, rosterUrl = FG_ROSTER_URL, rosterToken = FG_ROSTER_TOKEN,
} = {}) {
  try {
    const r = await fetchImpl(`${rosterUrl}/admin/autopilot-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${rosterToken}` },
      body: JSON.stringify(config),
    });
    if (!r.ok) return { error: `publish failed: ${r.status}` };
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/fg-autopilot-publish.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the app route in `server.js`**

Near the other `/api/fg/*` routes, add (imports at top of `server.js`: `import { buildAutopilotConfig } from './src/fg-autopilot.js'; import { publishAutopilotConfig } from './src/fg-autopilot-publish.js';`):

```js
// Publish the current FG team config to the cloud so Auto-Pilot can fire it.
app.post('/api/fg/autopilot/publish', async (req, res) => {
  const b = req.body || {};
  const config = buildAutopilotConfig({
    pairs: Array.isArray(b.pairs) ? b.pairs : [],
    keywords: Array.isArray(b.keywords) ? b.keywords : [],
    enabled: b.enabled !== false,
    days: Array.isArray(b.days) && b.days.length ? b.days : [1, 15],
    marketerDefaults: FG_MARKETER_KEYWORDS,
    publishedBy: getOperatorEmail() || req.user || '',
    publishedAt: new Date().toISOString(),
  });
  const r = await publishAutopilotConfig(config);
  if (r.error) return res.status(502).json(r);
  res.json({ ok: true, config });
});
```

- [ ] **Step 6: Run the app publish test again + a syntax check**

Run: `node --test tests/fg-autopilot-publish.test.js && node --check server.js`
Expected: PASS, and `node --check` prints nothing (valid syntax).

- [ ] **Step 7: Commit**

```bash
git add src/fg-autopilot-publish.js tests/fg-autopilot-publish.test.js server.js
git commit -m "feat(fg-autopilot): app publishes team config to the roster service"
```

---

### Task 7: App-side reconcile of Auto-Pilot runs

When the app is online, pull the service's Auto-Pilot run records and reconcile any not yet reconciled — writing "Invited" back to the FG sheet. Idempotent, lag-tolerant.

**Files:**
- Create: `src/fg-autopilot-reconcile.js` (pure merge/selection helper)
- Modify: `server.js` (call it inside the existing FG-cloud reconcile loop, ~`reconcileFgCloudRuns`)
- Test: `tests/fg-autopilot-reconcile.test.js`

**Interfaces:**
- Consumes: `reconcileCloudRun` (`src/connections/fg-cloud-launch.js`).
- Produces: `pickUnreconciled(serviceRuns, localReconciledCloudIds: Set) → run[]` — the auto-pilot run records (with `perAccount`) not yet reconciled locally.

- [ ] **Step 1: Write the failing test**

Create `tests/fg-autopilot-reconcile.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUnreconciled } from '../src/fg-autopilot-reconcile.js';

test('returns dispatched runs with perAccount that are not already reconciled locally', () => {
  const serviceRuns = [
    { cloudId: 'a', status: 'dispatched', perAccount: [{ profileId: 'p1' }] },
    { cloudId: 'b', status: 'dispatched', perAccount: [{ profileId: 'p2' }] },
    { cloudId: 'c', status: 'failed' }, // no perAccount, skip
  ];
  const out = pickUnreconciled(serviceRuns, new Set(['a']));
  assert.deepEqual(out.map((r) => r.cloudId), ['b']);
});

test('empty when everything reconciled or nothing dispatched', () => {
  assert.deepEqual(pickUnreconciled([{ cloudId: 'x', status: 'failed' }], new Set()), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/fg-autopilot-reconcile.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fg-autopilot-reconcile.js`**

```js
// Select Auto-Pilot run records that the local app hasn't reconciled yet. A run is
// reconcilable only once it has a perAccount map (dispatched successfully). Keyed by
// cloudId so reconcile stays idempotent across app restarts.
export function pickUnreconciled(serviceRuns, localReconciledCloudIds) {
  const done = localReconciledCloudIds instanceof Set ? localReconciledCloudIds : new Set(localReconciledCloudIds || []);
  return (serviceRuns || []).filter(
    (r) => r && r.cloudId && Array.isArray(r.perAccount) && r.perAccount.length && !done.has(r.cloudId),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/fg-autopilot-reconcile.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into the FG-cloud reconcile loop in `server.js`**

Inside `reconcileFgCloudRuns` (the function the 30s interval + the launch hook call), after it reconciles the local `_fgCloudRunStore` records, add a pull of the service's Auto-Pilot runs. Add the import `import { pickUnreconciled } from './src/fg-autopilot-reconcile.js';` and, at the end of that function's body:

```js
  // Also reconcile Auto-Pilot runs dispatched cloud-side while the app was closed.
  try {
    const resp = await fetch(`${FG_ROSTER_URL}/admin/autopilot`, {
      headers: { authorization: `Bearer ${FG_ROSTER_TOKEN}` },
    });
    if (resp.ok) {
      const { runs } = await resp.json();
      const localIds = new Set((_fgCloudRunStore.load() || []).map((r) => r.cloudId));
      for (const rec of pickUnreconciled(runs, localIds)) {
        _fgCloudRunStore.add({ ...rec, status: rec.status || 'dispatched' }); // adopt into the local reconcile pipeline
      }
    }
  } catch (_) { /* offline / service down — retried next tick */ }
```

Add the import for the roster URL/token at the top if not present: `import { FG_ROSTER_URL, FG_ROSTER_TOKEN } from './src/fg-roster-url.js';`. (The existing FG-cloud reconcile then processes the adopted records through `reconcileCloudRun` on its normal path — no second reconcile call needed.)

- [ ] **Step 6: Run the reconcile test + syntax check**

Run: `node --test tests/fg-autopilot-reconcile.test.js && node --check server.js`
Expected: PASS, no syntax errors.

- [ ] **Step 7: Commit**

```bash
git add src/fg-autopilot-reconcile.js tests/fg-autopilot-reconcile.test.js server.js
git commit -m "feat(fg-autopilot): app adopts + reconciles cloud auto-pilot runs"
```

---

### Task 8: Auto-Pilot UI panel on the FG board

Collapsed status strip by default; expand for eligibility, history, edit-schedule, and manual Run now. Vanilla HTML/CSS/JS, manual verification (no UI test suite per CLAUDE.md). Reuse the tokens/classes from the approved sketch (`public/sketches/2026-07-16-fg-autopilot.html`) and the real FG-board classes.

**Files:**
- Modify: `public/index.html` (panel markup + scoped CSS inside the `#nav-follower-growth` block; version `?v=` bump)
- Modify: `public/js/app.js` (render + wire the panel; publish on board open/change; Run now)
- Modify: `package.json` (version bump)

- [ ] **Step 1: Bump the version**

Bump `package.json` `version` (patch) and both `?v=` query strings in `public/index.html` `<head>` to match, per repo convention (so the UI shows the new build).

- [ ] **Step 2: Add the panel markup**

At the top of `#nav-follower-growth` (before the `①` roles block, `public/index.html:2054`), insert the collapsed strip + hidden expand body. Reuse the sketch's structure and the real `.fgtl-*`/token classes:

```html
<div class="fgap" id="fgap">
  <div class="fgap-strip">
    <span class="fgap-dot" id="fgap-dot"></span>
    <div class="fgap-lead">
      <div class="fgap-title" id="fgap-title">AUTO-PILOT · ON</div>
      <div class="fgap-next" id="fgap-next">Next run —</div>
    </div>
    <span class="rt-tag">☁︎ Cloud VM</span>
    <button type="button" class="fgap-edit" id="fgap-edit">Edit schedule</button>
    <button type="button" class="fgap-toggle on" id="fgap-toggle" role="switch" aria-checked="true" title="Toggle Auto-Pilot"></button>
    <button type="button" class="fgap-expand" id="fgap-expand" aria-expanded="false" title="Show details">⌄</button>
  </div>
  <div class="fgap-body" id="fgap-body" hidden>
    <div class="fgap-elig" id="fgap-elig"></div>
    <div class="fgap-hist-head">Recent auto-runs</div>
    <div class="fgap-hist" id="fgap-hist"></div>
    <button type="button" class="fgtl-go-btn" id="fgap-runnow" style="max-width:220px">Run now</button>
  </div>
</div>
```

Add scoped CSS in the `#nav-follower-growth` `<style>` block (reuse the sketch's rules for `.fgap-strip`, `.fgap-dot` (green `--green`), `.fgap-toggle`/`.on`, `.fgap-title` (mono uppercase), `.fgap-next`, `.fgap-body`, `.fgap-hist` rows). Copy them from `public/sketches/2026-07-16-fg-autopilot.html` (the `.ap-*`/`.hrow` rules), renamed to the `.fgap-*` prefix.

- [ ] **Step 3: Render + wire in `public/js/app.js`**

Add a `fgapRender()` and `fgapInit()` near the FG board code (`fgtlRenderPeople`, ~`app.js:17282`). Behaviour:
- On FG board open (wherever `fgtlPeople`/board is first loaded), call `fgapInit()`: GET `/api/fg/autopilot/publish`-published state by fetching `${roster}/admin/autopilot` **via the app** — add a small app proxy route `GET /api/fg/autopilot` in `server.js` that fetches the service's `GET /admin/autopilot` (so the browser uses same-origin, no token in the client). Render strip: title `AUTO-PILOT · ON/OFF`, `fgap-next` from `nextRun(new Date(), config)` (import `nextRun` into the client build, or compute server-side and include a `nextRunLabel` in the proxy response — prefer server-side to avoid shipping the module to the browser).
- Publish current config on board open and on any pairing/keyword/toggle/schedule change: POST `/api/fg/autopilot/publish` with `{ pairs: fgtlPairs(), keywords: fgtlChips, enabled, days }`.
- Toggle (`#fgap-toggle`): flip enabled, republish, update strip.
- Edit schedule (`#fgap-edit`): a minimal prompt/inline editor for `days` (v1: on/off + days only; time is fixed) → republish.
- Expand (`#fgap-expand`): toggle `#fgap-body [hidden]`; when shown, render eligibility from the existing "Ready to launch" computation (reuse the `#fgtl-ready` logic) into `#fgap-elig` as `.fgtl-prow` rows, and render `runs` into `#fgap-hist`.
- Run now (`#fgap-runnow`): POST the app proxy `/api/fg/autopilot/run` (which forwards `{force:true}` to the service `POST /admin/autopilot`), then surface the result on the existing `#fgtl-card` (it will appear via the normal cloud poll/reconcile). Confirm before firing.

Add the two app proxy routes in `server.js` (same-origin for the browser, token stays server-side):

```js
app.get('/api/fg/autopilot', async (_req, res) => {
  try {
    const r = await fetch(`${FG_ROSTER_URL}/admin/autopilot`, { headers: { authorization: `Bearer ${FG_ROSTER_TOKEN}` } });
    const j = await r.json();
    const cfg = j.config || { enabled: true, days: [1, 15] };
    res.json({ ...j, nextRunLabel: cfg.enabled ? nextRun(new Date(), cfg).toISOString() : null });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/fg/autopilot/run', async (_req, res) => {
  try {
    const r = await fetch(`${FG_ROSTER_URL}/admin/autopilot`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${FG_ROSTER_TOKEN}` }, body: JSON.stringify({ force: true }),
    });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: e.message }); }
});
```

(Import `nextRun`: `import { buildAutopilotConfig, nextRun } from './src/fg-autopilot.js';`.)

- [ ] **Step 4: Manual verification**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "ortus-gologin-clone.*[Ee]lectron" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```
Open the app → Follower Growth board. Verify:
- Collapsed strip shows `AUTO-PILOT · ON`, a next-run date, `Cloud VM`, `Edit schedule`, toggle, expand chevron.
- Toggling flips ON/OFF and the strip updates; reopening the board reflects the persisted state (round-trips through the service).
- Expand reveals eligibility rows (`.fgtl-prow` styling), recent-runs (empty until a run), and Run now.
- `node --check server.js` passes.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/app.js server.js package.json
git commit -m "feat(fg-autopilot): FG-board panel — collapsed strip + expand, publish/toggle/run-now"
```

---

## Final verification (after all tasks)

- [ ] Full suite: `node --test tests/*.test.js` — all green (new: `fg-autopilot`, `fg-roster-mailer`, `fg-roster-autopilot`, `fg-roster-autopilot-routes`, `fg-autopilot-publish`, `fg-autopilot-reconcile`).
- [ ] `node --check server.js` clean.
- [ ] Deploy artifacts (`kubectl apply --dry-run=client`) valid; actual prod apply + image roll + IAM grant are gated on explicit user approval and follow the runbook add-on — NOT part of the coding branch.
- [ ] No `data/*.json` staged; branch not pushed; no DMG built (per current constraints).

## Spec coverage self-check

- §4.1 shared decision module → Task 1. §4.2 config publisher + transport → Tasks 4 (service persist) + 6 (app publish). §4.3 handler/dispatch → Task 3, routes Task 4. §4.4 CronJob → Task 5. §4.5 mailer (off by default) → Task 2, wired Task 4/5. §4.6 UI → Task 8. §4.7 write-back reconcile → Task 7. §6 testing → each task's tests. §8 constraints → Global Constraints + per-task `git add` lines.
