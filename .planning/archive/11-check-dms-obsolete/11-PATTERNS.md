# Phase 11: Check DMs — Pattern Map

**Mapped:** 2026-04-21
**Files analyzed:** 13 new/modified (4 server, 3 UI, 1 Apps Script, 1 paths helper, 1 sheets writer extension, 3 server endpoints + 9 test files + 2 fixtures under `tests/`)
**Analogs found:** 13 / 13 (every new file has a concrete in-repo analog — Phase 11 is composition, not invention)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/linkedin/check-dms.js` **(NEW)** | server orchestration module | request-response + file-I/O + transform | `src/campaign.js` (orchestration loop) + `src/linkedin/helpers.js::getVoyagerDegree` (Voyager pattern) | exact — combine the two |
| `src/linkedin/helpers.js` (extend) | server utility | request-response | itself (add `getConversationsPage` next to `getVoyagerDegree`) | exact |
| `src/paths.js` (no change — reuse) | server utility | — | itself — just call `dataPath('check-dms-state.json')` | exact (zero-change) |
| `src/sheets-writer.js` (no new helper, reuse) | server utility | request-response | itself — `ensureTrackingColumns()` / `updateSheetRow()` already take arbitrary field names | exact (zero-change) |
| `server.js` — 3 new endpoints | server controller | request-response | `server.js:264-316` (`/api/campaign/start,stop,status`) | exact |
| `google-apps-script.js` — extend `TRACKING_COLUMNS` + `FIELD_MAP` | Apps Script config | CRUD | `google-apps-script.js:31-65` (existing arrays) | exact |
| `public/index.html` — Check DMs button + Replies panel markup | UI component | event-driven | `public/index.html:374-441` (Campaign launch + Live Status block) | exact (role + aesthetic) |
| `public/js/app.js` — `startCheckDms`, `startCheckDmsPolling`, `pollCheckDmsStatus`, `renderRepliesPanel` | UI logic | event-driven + polling | `public/js/app.js:1122-1329` (`startCampaign` + `startPolling` + `pollStatus`) | exact |
| `public/css/style.css` — `.replies-panel`, `.reply-row`, `.reply-error` | UI style | — | `public/css/style.css:954-1000` (`.status-grid`, `.log-panel`, `.progress-bar`) | exact (monochrome command deck) |
| `tests/fixtures/voyager-conversations-real.json` **(NEW)** | fixture | — | no existing fixtures — first one in the repo | no analog — define contract here |
| `tests/fixtures/sheet-rows-with-sent-dms.json` **(NEW)** | fixture | — | no existing fixtures | no analog |
| `tests/check-dms-*.test.js` (6 files) **(NEW)** | unit/integration tests | — | no existing tests — first ever | no analog — use `node --test` skeleton |
| `tests/ui/*.test.js` (2 files) **(NEW)** | UI smoke tests | — | no existing tests | no analog — document the jsdom/happy-dom decision in plan |

**No analog found** only for the `tests/` tree — this is the project's first test suite. Use `node --test` skeletons as described in RESEARCH.md §Validation Architecture.

---

## Pattern Assignments

### 1. `src/linkedin/check-dms.js` (NEW — server orchestration)

**Primary analog:** `src/campaign.js`
**Voyager fetch analog:** `src/linkedin/helpers.js:112-173` (`getVoyagerDegree`)

#### 1a. Module header + imports pattern

Copy the module header style from `src/campaign.js:1-48`:

```javascript
// src/campaign.js:22-29 — exact imports pattern to mirror
import { existsSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'node:fs/promises';
import { launchProfile, closeProfile, getProfiles } from './gologin-launcher.js';
import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
import { fetchSheet as fetchSheetRows } from './sheets.js';
import { updateSheetRow, ensureTrackingColumns } from './sheets-writer.js';
import { performOutreach } from './linkedin/outreach.js';
import { dataPath } from './paths.js';

// src/campaign.js:31-48 — state file pattern
const STATE_FILE = dataPath('state.json');
// ...
async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { processed: {}, dailyCounts: {} }; }
}
async function saveState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }
```

New file adapts to:
```javascript
// src/linkedin/check-dms.js — apply same shape
import { readFile, writeFile } from 'node:fs/promises';
import { launchProfile, closeProfile, getProfiles } from '../gologin-launcher.js';
import { fetchSheet as fetchSheetRows } from '../sheets.js';
import { updateSheetRow, ensureTrackingColumns } from '../sheets-writer.js';
import { getConversationsPage } from './helpers.js';   // new helper, see section 2
import { dataPath } from '../paths.js';

const STATE_FILE = dataPath('check-dms-state.json');

async function loadWatermarks() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
async function saveWatermarks(s) {
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}
```

#### 1b. Exposed state object (for polling endpoint)

Copy exactly from `src/campaign.js:97-106`:

```javascript
// src/campaign.js:97-106
export const campaign = {
  running: false,
  _abort: false,
  currentProfile: null,
  processedToday: 0,
  totalProcessed: 0,
  logs: [],
  errors: [],
};
```

New module mirrors with `checkDms`:

```javascript
// src/linkedin/check-dms.js — same shape, adapted fields
export const checkDms = {
  running: false,
  _abort: false,
  currentProfile: null,
  profileNames: [],
  repliesFound: 0,     // running count
  replies: [],         // [{ profileName, firstName, lastName, snippet, timestamp, threadId, linkedinUrl, ambiguous?, error? }]
  errors: [],
  logs: [],
};
```

Plus copy the `log()` + `pushError()` helpers verbatim from `src/campaign.js:108-117`:

```javascript
// src/campaign.js:108-117
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  campaign.logs.push(line);
  if (campaign.logs.length > 500) campaign.logs.shift();
}
function pushError(err) {
  campaign.errors.push({ time: new Date().toISOString(), message: err.message });
  if (campaign.errors.length > 100) campaign.errors.shift();
}
```

#### 1c. Profile-launch loop (health check + warmup + close)

The launch-health-warmup-close sequence in `src/campaign.js:361-486` is the authoritative pattern. Copy the shape but skip the parts that don't apply (the login-wait-120s logic IS still relevant because the GoLogin profile may need login). Key excerpt:

```javascript
// src/campaign.js:361-404 — distilled essentials
for (const profileId of profileIds) {
  if (campaign._abort) break;
  const pName = profileNameCache[profileId] || profileId;
  campaign.currentProfile = pName;

  try {
    log(`▶ Opening ${pName}…`);
    let launched;
    if (profileId === 'local-browser') {
      launched = await launchLocalBrowser();
    } else {
      launched = await launchProfile(profileId, token);
    }
    let page = launched.page;

    // Clear cache + service workers (keep cookies so login persists)
    try {
      const client = await page.target().createCDPSession();
      await client.send('Network.clearBrowserCache');
      await client.send('ServiceWorker.unregister', { scopeURL: 'https://www.linkedin.com/' }).catch(() => {});
    } catch { /* skip */ }

    try {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) { log(`⚠ Home nav: ${e.message}`); }

    // Health check — reuse checkProfileHealth from src/campaign.js:190-233
    const health = await checkProfileHealth(page, pName);
    if (!health.healthy) { /* login-wait loop */ }

    // Warmup
    await new Promise(r => setTimeout(r, 20000));
    // ... do the Voyager scan here ...
  } catch (err) {
    log(`✗ ${pName}: ${err.message}`); pushError(err);
  }
}
```

**CRITICAL anti-pattern reminder** (RESEARCH.md §Anti-Patterns): do NOT copy-paste this block. Either:
- Import `checkProfileHealth` directly (export it from `src/campaign.js` — low-risk extension), OR
- Extract into a shared `src/profile-session.js` helper.

The plan must pick one. The least invasive route: add `export { checkProfileHealth }` to `src/campaign.js` (one-line change, satisfies CLAUDE.md "Preserve all core automation logic" since it's additive), and import it from `check-dms.js`.

#### 1d. Pre-filter rows (per-profile scoping)

Adapt `src/campaign.js:296-331`. Relevant excerpt:

```javascript
// src/campaign.js:296-331
const targets = rows.filter(row => {
  const url = extractLinkedInUrl(row, linkedinColumn);
  if (!url) return false;

  const msgCell = (row['Message'] || row['message'] || '').toString().toLowerCase().trim();
  const opCell  = (row['OP']      || row['op']      || '').toString().toLowerCase().trim();
  const msgSent = msgCell === 'sent' || opCell === 'sent';
  // ...
});
```

Check DMs filter (adapt to per-profile scoping per CONTEXT.md §Per-profile scoping):

```javascript
// src/linkedin/check-dms.js — per-profile candidate filter
function candidatesForProfile(rows, profileName, linkedinColumn) {
  return rows.filter(row => {
    if (!extractLinkedInUrl(row, linkedinColumn)) return false;
    const msgCell     = (row['Message']      || row['message']      || '').toString().toLowerCase().trim();
    const accountUsed = (row['Account Used'] || row['account used'] || '').toString().trim();
    if (msgCell !== 'sent') return false;
    if (accountUsed.toLowerCase() !== profileName.toLowerCase()) return false;
    return true;
  });
}
```

`extractLinkedInUrl` already exists at `src/campaign.js:60-83`. Either export + reuse it, or duplicate the 20 lines (acceptable given small size).

#### 1e. Voyager scan with short-circuit pagination

Already spelled out in RESEARCH.md §Code Examples §1 ("Full Voyager scan with short-circuit pagination"). Lift it verbatim into `src/linkedin/check-dms.js` — it is designed to drop in.

#### 1f. Match logic (pure function)

Already spelled out in RESEARCH.md §Pattern 2. Lift `normalizeName` + `matchConversation` verbatim.

#### 1g. Atomic watermark advance

Already spelled out in RESEARCH.md §Pattern 3. Lift the `scanOneProfile` / top-level loop verbatim.

#### 1h. Non-destructive sheet writeback pre-check

Before calling `updateSheetRow(...)`, do the server-side read-before-write described in RESEARCH.md §Pitfall 4. Pattern:

```javascript
// src/linkedin/check-dms.js — non-destructive write
async function writeReplyIfFresh(sheetUrl, linkedinUrl, fields, linkedinColumn) {
  // getStatus Apps Script action exists today — google-apps-script.js:429-463
  const status = await postToWebApp({ action: 'getStatus', sheetId: extractSheetId(sheetUrl), linkedinUrl });
  const existingReply = (status?.rows?.[0]?.['Reply'] || '').toString().toLowerCase().trim();
  if (existingReply === 'yes') {
    log(`  ↷ Skipped ${linkedinUrl} — Reply already "yes" (operator edits preserved)`);
    return false;
  }
  return updateSheetRow(sheetUrl, linkedinUrl, fields, linkedinColumn);
}
```

Note: `postToWebApp` is currently module-private in `src/sheets-writer.js:18-59`. Either export it (trivial), or add a new `getSheetRowStatus(sheetUrl, linkedinUrl)` helper to `src/sheets-writer.js`. Prefer the new helper — it keeps the `postToWebApp` internal and names the intent.

#### 1i. Public entry point

Copy the shape of `startCampaign` at `src/campaign.js:239-253`:

```javascript
// src/campaign.js:239-253
export async function startCampaign({ profileIds, sheetUrl, templates, dailyLimit = 40, mode = 'connect_only', /* ... */ }) {
  if (campaign.running) throw new Error('Campaign already running');
  campaign.running = true;
  campaign._abort = false;
  campaign.currentProfile = null;
  // ...
}
```

New module:

```javascript
// src/linkedin/check-dms.js
export async function startCheckDms({ profileIds, sheetUrl, linkedinColumn = '' }) {
  if (checkDms.running) throw new Error('Check DMs already running');
  checkDms.running = true;
  checkDms._abort = false;
  checkDms.currentProfile = null;
  checkDms.profileNames = [];
  checkDms.repliesFound = 0;
  checkDms.replies = [];
  checkDms.errors = [];
  // ... orchestration ...
}

export function stopCheckDms() { checkDms._abort = true; log('■ Stop requested.'); }

// src/campaign.js:919-931 — mirror getCampaignStatus exactly
export function getCheckDmsStatus() {
  return {
    running: checkDms.running,
    currentProfile: checkDms.currentProfile,
    profileNames: checkDms.profileNames,
    repliesFound: checkDms.repliesFound,
    errors: checkDms.errors.slice(-20),
    logs: checkDms.logs.slice(-100),
  };
}

export function getCheckDmsReplies() {
  return checkDms.replies.slice();
}
```

---

### 2. `src/linkedin/helpers.js` — add `getConversationsPage`

**Analog:** `src/linkedin/helpers.js:112-173` (`getVoyagerDegree`) — adjacent, same file, exact same pattern.

The full implementation is already specified in RESEARCH.md §Pattern 1 ("Voyager-in-page-evaluate"). Headers are verified against the `getVoyagerDegree` call at lines 128-138:

```javascript
// src/linkedin/helpers.js:128-138 — header pattern to duplicate
const resp = await fetch(
  `https://www.linkedin.com/voyager/api/identity/profiles/${publicId}/networkinfo`,
  {
    headers: {
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
      'csrf-token': token,
      'x-restli-protocol-version': '2.0.0',
    },
    credentials: 'include',
  }
);
if (!resp.ok) return null;
const data = await resp.json();
```

The new export (from RESEARCH.md §Pattern 1) is a drop-in next to `getVoyagerDegree`.

**CSRF-from-JSESSIONID pattern** (reuse verbatim from `src/linkedin/helpers.js:121-126`):

```javascript
// src/linkedin/helpers.js:121-126 — copy/paste inside page.evaluate
const csrf = document.cookie.split(';')
  .map(c => c.trim())
  .find(c => c.startsWith('JSESSIONID='));
if (!csrf) return null;
const token = csrf.split('=')[1]?.replace(/"/g, '');
```

---

### 3. `src/paths.js` — zero-change reuse

`src/paths.js:17-19` already provides exactly what Phase 11 needs:

```javascript
// src/paths.js:17-19
export function dataPath(...segments) {
  return resolve(ROOT, ...segments);
}
```

Call it as `dataPath('check-dms-state.json')` — no edits to this file.

---

### 4. `src/sheets-writer.js` — extend with `getSheetRowStatus` helper (or export `postToWebApp`)

**Analog:** `src/sheets-writer.js:96-121` (`updateSheetRow`).

Pattern to copy for a new helper:

```javascript
// src/sheets-writer.js:96-121 — template for new helper
export async function updateSheetRow(sheetUrl, linkedinUrl, tracking, linkedinColumn) {
  if (!getWebAppUrl()) return false;
  const sheetId = extractSheetId(sheetUrl);
  const result = await postToWebApp({
    action: 'updateRow',
    sheetId,
    linkedinUrl,
    urlColumnName: linkedinColumn || '',
    ...tracking,
  });
  if (result?.success) return true;
  if (result?.error) console.warn(`[sheets-writer] Update failed for ${linkedinUrl}: ${result.error}`);
  return false;
}
```

New helper to add:

```javascript
// src/sheets-writer.js — NEW export
export async function getSheetRowStatus(sheetUrl, linkedinUrl) {
  if (!getWebAppUrl()) return null;
  const sheetId = extractSheetId(sheetUrl);
  const result = await postToWebApp({
    action: 'getStatus',          // existing Apps Script action, see google-apps-script.js:429-463
    sheetId,
    linkedinUrl,
  });
  if (result?.rows) return result.rows[0] || null;
  if (result?.error) console.warn(`[sheets-writer] getStatus failed for ${linkedinUrl}: ${result.error}`);
  return null;
}
```

No change to `ensureTrackingColumns` — it already delegates column management to Apps Script (`handleEnsureColumns` in `google-apps-script.js:128-204`), which reads `TRACKING_COLUMNS` as its source of truth. Once we extend `TRACKING_COLUMNS` (see §5), the existing `ensureTrackingColumns` call in `startCheckDms` auto-adds the new columns.

**Calling pattern in `check-dms.js`**:
```javascript
// src/linkedin/check-dms.js — mirrors src/campaign.js:284-286
await ensureTrackingColumns(sheetUrl).catch(err => {
  log(`⚠ Could not ensure tracking columns: ${err.message}`);
});
```

---

### 5. `server.js` — 3 new Express endpoints

**Analog:** `server.js:264-316` (`/api/campaign/start`, `/api/campaign/stop`, `/api/campaign/status`).

**Imports extension** (near `server.js:18`):
```javascript
// server.js:18 — existing
import { startCampaign, stopCampaign, getCampaignStatus, campaign } from './src/campaign.js';
// NEW — add:
import { startCheckDms, stopCheckDms, getCheckDmsStatus, getCheckDmsReplies, checkDms } from './src/linkedin/check-dms.js';
```

**Endpoint pattern — copy the shape of `/api/campaign/start`** at `server.js:264-307`:

```javascript
// server.js:264-307 — template
app.post('/api/campaign/start', (req, res) => {
  try {
    const { profileIds, sheetUrl, templates, dailyLimit, mode, /* ... */ } = req.body;
    if (!profileIds?.length) return res.status(400).json({ error: 'profileIds required' });
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    const owner = req.user;
    startCampaign({ profileIds, sheetUrl, /* ... */ }).then(() => {
      const status = getCampaignStatus();
      notifyEmail(owner, { title: 'Campaign finished', body: '...', link: '/' }).catch(() => {});
    }).catch(err => {
      console.error('Campaign error:', err.message);
      notifyEmail(owner, { title: 'Campaign failed', body: `...${err.message}`, link: '/' }).catch(() => {});
    });

    res.json({ ok: true, message: 'Campaign started' });
  } catch (err) {
    console.error('Campaign start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

New endpoints (apply RESEARCH.md §Code Examples §3 nearly verbatim, plus the mutex guard from Anti-Patterns):

```javascript
// server.js — insert AFTER the /api/campaign/status block (after line 316)
app.post('/api/check-dms/start', (req, res) => {
  try {
    // Mutex — see RESEARCH.md §Pitfall 5
    if (campaign.running) {
      return res.status(409).json({ error: 'Cannot check DMs while a campaign is running' });
    }
    if (checkDms.running) {
      return res.status(409).json({ error: 'Check DMs already running' });
    }
    const { profileIds, sheetUrl, linkedinColumn } = req.body;
    if (!profileIds?.length) return res.status(400).json({ error: 'profileIds required' });
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    const owner = req.user;
    startCheckDms({ profileIds, sheetUrl, linkedinColumn: linkedinColumn || '' })
      .then(() => {
        const s = getCheckDmsStatus();
        notifyEmail(owner, {
          title: 'Check DMs finished',
          body: `Found ${s.repliesFound || 0} new reply(ies). ${(s.errors || []).length} error(s).`,
          link: '/',
        }).catch(() => {});
      })
      .catch(err => {
        console.error('Check DMs error:', err.message);
        notifyEmail(owner, { title: 'Check DMs failed', body: err.message, link: '/' }).catch(() => {});
      });

    res.json({ ok: true, message: 'Check DMs started' });
  } catch (err) {
    console.error('Check DMs start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/check-dms/stop', (_req, res) => {
  res.json(stopCheckDms());
});

app.get('/api/check-dms/status', (_req, res) => {
  res.json(getCheckDmsStatus());
});

app.get('/api/check-dms/replies', (_req, res) => {
  res.json({ replies: getCheckDmsReplies() });
});
```

**Existing `/api/campaign/start` also needs a guard against `checkDms.running`** (symmetric mutex, RESEARCH.md §Pitfall 5):
```javascript
// server.js:264 — add guard near existing checks
if (checkDms.running) {
  return res.status(409).json({ error: 'Cannot start campaign while Check DMs is running' });
}
```

---

### 6. `google-apps-script.js` — extend `TRACKING_COLUMNS` and `FIELD_MAP`

**Analog:** `google-apps-script.js:31-65` (existing arrays). RESEARCH.md §Code Examples §2 has the literal before/after diff. Canonical excerpt:

```javascript
// google-apps-script.js:31-39 — current
var TRACKING_COLUMNS = [
  'Status',
  'CC',
  'OP',
  'Message',
  'InMail',
  'Account Used',
  'Date Last Action'
];

// google-apps-script.js:57-65 — current
var FIELD_MAP = {
  status:          'Status',
  cc:              'CC',
  op:              'OP',
  message:         'Message',
  inmail:          'InMail',
  accountUsed:     'Account Used',
  dateLastAction:  'Date Last Action'
};
```

Extend to:

```javascript
var TRACKING_COLUMNS = [
  'Status',
  'CC',
  'OP',
  'Message',
  'InMail',
  'Reply',          // NEW
  'Reply At',       // NEW
  'Reply Preview',  // NEW
  'Account Used',
  'Date Last Action'
];

var FIELD_MAP = {
  status:          'Status',
  cc:              'CC',
  op:              'OP',
  message:         'Message',
  inmail:          'InMail',
  reply:           'Reply',          // NEW
  replyAt:         'Reply At',       // NEW
  replyPreview:    'Reply Preview',  // NEW
  accountUsed:     'Account Used',
  dateLastAction:  'Date Last Action'
};
```

**DO NOT** add the new columns to `ACTION_COLUMNS` (line 42) — `ACTION_COLUMNS` triggers dash-fill in `writeFields` (`google-apps-script.js:558-565`) which is wrong for Reply columns (empty = "no reply yet", not "—").

The existing `handleEnsureColumns` (lines 128-204) reads `TRACKING_COLUMNS` and auto-inserts missing columns — **no logic change needed**. Existing `writeFields` (lines 530-579) reads `FIELD_MAP` and writes whatever fields are passed — **no logic change needed**.

**Deployment note**: Apps Script uses HEAD deployment per CLAUDE.md — paste this file into the Apps Script editor once and any later changes pick up without redeploy.

---

### 7. `public/index.html` — Check DMs button + Replies panel

**Analog (button placement):** `public/index.html:374-379` (Start/Stop Campaign buttons inside the launch-now-panel).
**Analog (panel structure):** `public/index.html:417-441` (Live Status section).

#### 7a. Button — drop INTO the existing Campaign section (not a new nav item)

Copy the style + structure of `public/index.html:374-379`:

```html
<!-- public/index.html:374-379 — existing launch-now-panel -->
<div class="launch-panel panel-active" id="launch-now-panel">
  <div class="launch-actions">
    <button id="btn-start" class="btn btn-start" onclick="startCampaign()">Start Campaign</button>
    <button id="btn-stop" class="btn btn-stop" onclick="stopCampaign()" disabled>Stop Campaign</button>
  </div>
</div>
```

Adapted: add a Check DMs button as a sibling row inside the same Campaign section (design-locked in CONTEXT.md §Phase Boundary: "inside the existing Campaign section (no tab-framework dependency)"):

```html
<!-- Insert after the launch-actions block ~line 378 -->
<div class="launch-actions" style="margin-top:12px">
  <button id="btn-check-dms" class="btn btn-secondary" onclick="startCheckDms()">Check DMs</button>
</div>
```

`btn-secondary` already exists in the codebase (used on log copy/clear buttons at `public/index.html:436-437`) — monochrome, hairline-bordered.

#### 7b. Replies panel — mirrors Live Status section (`public/index.html:417-441`)

```html
<!-- public/index.html:417-441 — pattern to copy -->
<div class="section collapsible collapsed" id="nav-status">
  <h2 class="section-toggle" onclick="toggleSection('nav-status')">
    <span class="caret">▾</span> <span data-edit="h2-status">Live Status</span>
  </h2>
  <div class="collapsible-body">
    <div class="status-grid">
      <div class="stat-card"><div class="label">Status</div><div class="value" id="st-running">Idle</div></div>
      <!-- ... more stat cards ... -->
    </div>
    <div class="progress-bar"><div class="fill" id="st-bar" style="width:0%"></div></div>
    <div class="log-panel" id="log-panel"><div class="entry info">Waiting to start…</div></div>
  </div>
</div>
```

New Replies panel — same `<div class="section collapsible">` + `<h2 class="section-toggle">` wrapper, hidden until replies are populated:

```html
<!-- Insert near the Live Status section -->
<div class="section collapsible collapsed" id="nav-replies" style="display:none">
  <h2 class="section-toggle" onclick="toggleSection('nav-replies')">
    <span class="caret">▾</span> <span data-edit="h2-replies">Replies</span>
    <span class="replies-count" id="replies-count"></span>
  </h2>
  <div class="collapsible-body">
    <div id="replies-errors" class="replies-errors"></div>    <!-- error tile — see Pitfall 6 -->
    <div id="replies-list" class="replies-list">
      <p class="empty-state">No replies yet. Run Check DMs from the Campaign section.</p>
    </div>
  </div>
</div>
```

---

### 8. `public/js/app.js` — `startCheckDms`, polling, rendering

**Analog:** `public/js/app.js:1122-1329` (`startCampaign` + `startPolling` + `pollStatus`).

#### 8a. `startCheckDms` — mirrors `startCampaign` at lines 1122-1206 (simpler: no templates/rate/daily limit)

```javascript
// public/js/app.js:1122-1206 — key shape
async function startCampaign() {
  if (selectedProfileIds.length === 0) { alert('Select at least one GoLogin profile.'); return; }
  const sheetUrl = document.getElementById('sheet-url').value.trim();
  if (!sheetUrl) { alert('Enter a Google Sheet URL.'); return; }
  // ... validation + templates ...
  try {
    const res = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds: selectedProfileIds, sheetUrl, templates, /* ... */ }),
    });
    const data = await res.json();
    if (data.error) { alert(`Error: ${data.error}`); return; }
    if (!data.ok) { alert(data.message || 'Could not start campaign.'); return; }
    setCampaignButtons(true);
    startPolling();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}
```

Adapt to:

```javascript
// public/js/app.js — NEW
async function startCheckDms() {
  if (selectedProfileIds.length === 0) { alert('Select at least one GoLogin profile.'); return; }
  const sheetUrl = document.getElementById('sheet-url').value.trim();
  if (!sheetUrl) { alert('Enter a Google Sheet URL.'); return; }

  const btn = document.getElementById('btn-check-dms');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/check-dms/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileIds: selectedProfileIds,
        sheetUrl,
        linkedinColumn: document.getElementById('linkedin-col-select')?.value || '',
      }),
    });
    const data = await res.json();
    if (data.error) { alert(`Error: ${data.error}`); if (btn) btn.disabled = false; return; }
    if (!data.ok) { alert(data.message || 'Could not start Check DMs.'); if (btn) btn.disabled = false; return; }
    startCheckDmsPolling();
  } catch (err) {
    alert(`Failed: ${err.message}`);
    if (btn) btn.disabled = false;
  }
}
```

#### 8b. Polling — mirrors `startPolling` / `pollStatus` at lines 1235-1329

Canonical excerpt:
```javascript
// public/js/app.js:1235-1244
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollStatus, 2000);
  pollStatus();
}
function stopPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
}
```

New:

```javascript
// public/js/app.js — NEW
let checkDmsPollInterval = null;

function startCheckDmsPolling() {
  if (checkDmsPollInterval) return;
  checkDmsPollInterval = setInterval(pollCheckDmsStatus, 2000);
  pollCheckDmsStatus();
}

async function pollCheckDmsStatus() {
  try {
    const res = await fetch('/api/check-dms/status');
    const s = await res.json();
    // Progress indicator: reuse .log-panel or a new small status line
    renderCheckDmsProgress(s);

    if (!s.running && checkDmsPollInterval) {
      clearInterval(checkDmsPollInterval);
      checkDmsPollInterval = null;
      const r = await fetch('/api/check-dms/replies').then(r => r.json());
      renderRepliesPanel(r.replies || [], s.errors || []);
      const btn = document.getElementById('btn-check-dms');
      if (btn) btn.disabled = false;
      notify('Check DMs finished', `${(r.replies || []).length} reply(ies).`);
    }
  } catch { /* transient */ }
}
```

#### 8c. Renderer — `renderRepliesPanel(replies, errors)`

**CRITICAL security rule** (RESEARCH.md §Anti-Patterns): do NOT use `innerHTML` with LinkedIn-sourced text. The existing `renderAccountQueue` at `public/js/app.js:1220-1230` uses `innerHTML` with `escHtml()`:

```javascript
// public/js/app.js:1220-1230 — existing pattern (uses escHtml wrapper)
function renderAccountQueue(names, currentName) {
  const el = document.getElementById('account-queue');
  if (!names || names.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = names.map((name, i) => {
    let cls = 'queue-item';
    if (currentName && name === currentName) cls += ' active';
    else if (currentName && names.indexOf(currentName) > i) cls += ' done';
    return `<div class="${cls}"><span class="num">${i + 1}</span><span class="name">${escHtml(name)}</span></div>`;
  }).join('');
}
```

For reply snippets use `textContent` (DOM-API pattern) to defeat HTML injection even if `escHtml` has gaps:

```javascript
// public/js/app.js — NEW
function renderRepliesPanel(replies, errors) {
  const section = document.getElementById('nav-replies');
  section.style.display = '';
  const countEl = document.getElementById('replies-count');
  if (countEl) countEl.textContent = replies.length ? ` (${replies.length})` : '';

  // Error tile FIRST — Pitfall 6
  const errBox = document.getElementById('replies-errors');
  errBox.innerHTML = '';
  if (errors && errors.length) {
    const div = document.createElement('div');
    div.className = 'reply-error';
    div.textContent = `Check DMs hit ${errors.length} error(s). Retry in 10–15 min. Watermark NOT advanced.`;
    errBox.appendChild(div);
  }

  const list = document.getElementById('replies-list');
  list.innerHTML = '';  // safe — we built no user text yet
  if (!replies.length && !(errors && errors.length)) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No new replies.';
    list.appendChild(p);
    return;
  }

  for (const r of replies) {
    const row = document.createElement('div');
    row.className = 'reply-row' + (r.ambiguous ? ' reply-ambiguous' : '');

    const name = document.createElement('div');
    name.className = 'reply-name';
    name.textContent = `${r.firstName || ''} ${r.lastName || ''}`.trim() + (r.ambiguous ? ' — ambiguous' : '');

    const snippet = document.createElement('div');
    snippet.className = 'reply-snippet';
    snippet.textContent = r.snippet || '';    // textContent — LinkedIn payload is untrusted

    const meta = document.createElement('div');
    meta.className = 'reply-meta';
    meta.textContent = `${formatRelative(r.timestamp)} • ${r.profileName || ''}`;

    const actions = document.createElement('div');
    actions.className = 'reply-actions';
    if (r.threadId) {
      const a = document.createElement('a');
      a.className = 'btn btn-secondary btn-sm';
      a.href = `https://www.linkedin.com/messaging/thread/${r.threadId}/`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open Thread';
      actions.appendChild(a);
    }

    row.appendChild(name);
    row.appendChild(snippet);
    row.appendChild(meta);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function formatRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
```

`notify(...)` already exists in the file — reuse (used by `pollStatus` at line 1254).

---

### 9. `public/css/style.css` — Replies panel styles

**Analog:** `public/css/style.css:954-1000` (`.status-grid`, `.stat-card`, `.log-panel`, `.progress-bar`).

Canonical monochrome patterns to reuse:

```css
/* public/css/style.css:979-990 — log-panel is the closest visual analog */
.log-panel {
  background: transparent;
  border: 1px solid var(--hairline); border-radius: 0;
  padding: 16px 20px; max-height: 420px; overflow-y: auto;
  font-family: var(--mono); font-size: 0.72rem; line-height: 1.7;
  letter-spacing: 0.02em;
}
.log-panel .entry { padding: 2px 0; color: var(--gray); }
.log-panel .entry.success { color: var(--green); }
.log-panel .entry.error { color: var(--red); }
```

New styles (respect the "command deck" constraints in RESEARCH.md §Project Constraints — only `var(--bg) / --ink / --gray / --hairline`, `--green`/`--red` ONLY for functional success/error):

```css
/* public/css/style.css — append near existing log-panel styles */
.replies-list {
  border: 1px solid var(--hairline);
  border-radius: 0;
}
.reply-row {
  padding: 14px 20px;
  border-bottom: 1px solid var(--hairline-soft);
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas:
    "name actions"
    "snippet snippet"
    "meta actions";
  gap: 4px 16px;
}
.reply-row:last-child { border-bottom: none; }
.reply-name {
  grid-area: name;
  font-family: var(--display); font-weight: 400; font-size: 0.95rem;
  color: var(--ink);
}
.reply-snippet {
  grid-area: snippet;
  font-family: var(--mono); font-size: 0.72rem; line-height: 1.6;
  color: var(--ink); opacity: 0.85;
}
.reply-meta {
  grid-area: meta;
  font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--gray);
}
.reply-actions { grid-area: actions; align-self: start; }
.reply-ambiguous .reply-name { color: var(--gray); font-style: italic; }

/* Error tile — use --red only for functional state */
.reply-error {
  margin-bottom: 12px; padding: 12px 16px;
  border: 1px solid var(--red);
  font-family: var(--mono); font-size: 0.72rem; color: var(--red);
}
.replies-count { color: var(--gray); font-family: var(--mono); font-size: 0.7rem; }
```

---

### 10. Tests — `tests/check-dms-*.test.js`

**No existing analog** — this is the project's first test suite. Follow RESEARCH.md §Test Framework: `node --test`, no new deps for the server/unit tests, optional `happy-dom` devDep for UI tests (requires justification in plan or drop).

Skeleton pattern:

```javascript
// tests/check-dms-match.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchConversation } from '../src/linkedin/check-dms.js';

describe('matchConversation', () => {
  it('returns matched=true for exact first+last name', () => {
    const conv = { firstName: 'Jane', lastName: 'Doe', publicIdentifier: 'jane-doe' };
    const rows = [{ firstName: 'Jane', lastName: 'Doe', linkedinUrl: 'https://linkedin.com/in/jane-doe' }];
    assert.equal(matchConversation(conv, rows).matched, true);
  });

  it('returns ambiguous when two rows share a name and no URL tiebreak succeeds', () => {
    const conv = { firstName: 'David', lastName: 'Kim', publicIdentifier: null };
    const rows = [
      { firstName: 'David', lastName: 'Kim', linkedinUrl: '' },
      { firstName: 'David', lastName: 'Kim', linkedinUrl: '' },
    ];
    assert.equal(matchConversation(conv, rows).reason, 'ambiguous');
  });
});
```

Each test file follows `describe` / `it` + `node:assert/strict` — no framework to choose, no config.

---

### 11. Fixtures — `tests/fixtures/*.json`

**No analog.** First fixtures in the repo.

**Wave 0 critical task**: capture one real Voyager `/voyager/api/messaging/conversations` response into `tests/fixtures/voyager-conversations-real.json`. Process (described in RESEARCH.md §Summary):
1. Run a throwaway `page.evaluate` inside an authenticated GoLogin profile
2. Pretty-print the JSON
3. Commit as the parser contract
4. Write the `extractConversationsArray` adapter against the actual field names observed

Shape of `tests/fixtures/sheet-rows-with-sent-dms.json`:
```json
[
  { "firstName": "Jane", "lastName": "Doe", "LinkedIn URL": "https://linkedin.com/in/jane-doe",
    "Message": "sent", "Account Used": "Antonio", "Reply": "" },
  { "firstName": "David", "lastName": "Kim", "LinkedIn URL": "",
    "Message": "sent", "Account Used": "Antonio", "Reply": "yes" },
  { "firstName": "David", "lastName": "Kim", "LinkedIn URL": "",
    "Message": "sent", "Account Used": "Antonio", "Reply": "" }
]
```

---

## Shared Patterns

### Auth / Cookie-inheritance (Voyager)

**Source:** `src/linkedin/helpers.js:112-138` (`getVoyagerDegree`)
**Apply to:** New `getConversationsPage` helper + any future Voyager helper. DO NOT extract cookies Node-side.

```javascript
const csrf = document.cookie.split(';')
  .map(c => c.trim())
  .find(c => c.startsWith('JSESSIONID='));
if (!csrf) return null;
const token = csrf.split('=')[1]?.replace(/"/g, '');

const resp = await fetch(url, {
  headers: {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'csrf-token': token,
    'x-restli-protocol-version': '2.0.0',
  },
  credentials: 'include',
});
```

### State persistence (per-user data dir)

**Source:** `src/paths.js:17-19` + `src/campaign.js:31-48`
**Apply to:** `check-dms-state.json`, anywhere else state persists.

```javascript
const STATE_FILE = dataPath('check-dms-state.json');
async function load() { try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return {}; } }
async function save(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }
```

### Error handling (server-side background task)

**Source:** `server.js:286-300` (campaign start handler)
**Apply to:** `/api/check-dms/start`.

```javascript
startBackgroundTask(...)
  .then(() => { notifyEmail(owner, { title: '... finished', body: '...', link: '/' }).catch(() => {}); })
  .catch(err => {
    console.error('Task error:', err.message);
    notifyEmail(owner, { title: '... failed', body: err.message, link: '/' }).catch(() => {});
  });
res.json({ ok: true, message: '... started' });
```

### Exposed state + `log()` / `pushError()`

**Source:** `src/campaign.js:97-117`
**Apply to:** `src/linkedin/check-dms.js` verbatim — just rename `campaign` → `checkDms`.

### Mutex between long-running server tasks

**Source:** RESEARCH.md §Pitfall 5 (no existing codebase precedent — introduce with Phase 11).
**Apply to:** `/api/campaign/start` (guard `checkDms.running`) and `/api/check-dms/start` (guard `campaign.running` + `checkDms.running`).

### UI polling loop

**Source:** `public/js/app.js:1235-1329` (`startPolling` + `pollStatus`)
**Apply to:** `startCheckDmsPolling` / `pollCheckDmsStatus`. 2s cadence, self-clears on `!running`.

### Safe DOM rendering for untrusted text

**Source:** `public/js/app.js:1220-1230` (`escHtml` wrapper) — but upgrade to `textContent` for LinkedIn-sourced reply bodies.
**Apply to:** Reply snippets + participant names in `renderRepliesPanel`. DO NOT use `innerHTML` with Voyager payload text.

### External-browser thread opening

**Source:** `electron/main.js:96-102` (`setWindowOpenHandler`)
**Apply to:** "Open Thread" button. Plain `<a target="_blank" rel="noopener noreferrer">` is sufficient — zero new plumbing.

### Sheet writeback via Apps Script

**Source:** `src/sheets-writer.js:67-121` (`ensureTrackingColumns`, `updateSheetRow`) + `google-apps-script.js:31-65` (config arrays) + `google-apps-script.js:530-579` (`writeFields`)
**Apply to:** Everything that writes to the sheet. Extend `TRACKING_COLUMNS` / `FIELD_MAP`; do NOT introduce a parallel Google Sheets API client (RESEARCH.md §Don't Hand-Roll).

### Monochrome "command deck" aesthetic

**Source:** `public/css/style.css:954-1000` (`.status-grid`, `.log-panel`)
**Apply to:** All new Replies panel styles. Only `var(--bg) / --ink / --gray / --hairline / --hairline-soft`; `--green` / `--red` only for functional states.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `tests/check-dms-*.test.js` (6 unit/integration tests) | test | — | Repository has no prior test suite. Use `node --test` pattern from RESEARCH.md. |
| `tests/ui/*.test.js` (2 UI smoke tests) | test | — | No existing UI tests. Planner must decide on `happy-dom`/`jsdom` devDep or defer. |
| `tests/fixtures/voyager-conversations-real.json` | fixture | — | No existing fixtures. Capture in Wave 0. |
| `tests/fixtures/sheet-rows-with-sent-dms.json` | fixture | — | No existing fixtures. |

For all of the above, reference RESEARCH.md §Validation Architecture as the source of truth.

---

## Metadata

**Analog search scope:**
- `src/` — primary (11 files scanned)
- `src/linkedin/` — primary (3 files scanned: actions, helpers, outreach)
- `public/` — html, js, css (3 files scanned)
- `server.js` — primary (1 file scanned)
- `google-apps-script.js` — primary (1 file scanned)
- `electron/main.js` — auxiliary verification (1 file scanned)
- `tests/` — confirmed absent

**Files scanned:** 20
**Pattern extraction date:** 2026-04-21
**Key confidence:** HIGH — every new file has a concrete in-repo analog except the `tests/` tree, which RESEARCH.md already provides a full skeleton for.
