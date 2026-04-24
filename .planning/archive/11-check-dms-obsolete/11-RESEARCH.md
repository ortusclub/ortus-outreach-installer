# Phase 11: Check DMs — Research

**Researched:** 2026-04-21
**Domain:** LinkedIn Voyager messaging API + per-profile reply scanning UI/sheet writeback
**Confidence:** HIGH for architectural plumbing (all patterns exist in the codebase), MEDIUM for the exact Voyager response schema (undocumented, reverse-engineered — must validate against a live payload in Wave 0)

## Summary

Phase 11 adds a manual "Check DMs" flow that reuses almost every existing primitive in the codebase: the Voyager-API-via-page.evaluate pattern from `src/linkedin/helpers.js` (`getVoyagerDegree`), the round-robin profile-launch loop from `src/campaign.js`, the `ensureTrackingColumns` + `updateSheetRow` sheet writeback from `src/sheets-writer.js`, and the `shell.openExternal` redirect already wired into `electron/main.js` via `setWindowOpenHandler`. There is no new infrastructure to stand up — only new orchestration, a new Voyager endpoint, a new state file, and new UI.

The single significant unknown is the exact shape of the Voyager `/voyager/api/messaging/conversations` response (field names, pagination envelope, timestamp units). The unofficial community libraries (nsandman/linkedin-api, tomquirk/linkedin-api) all call `/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX` with REST-li `start`/`count` offset pagination — but LinkedIn quietly rotates these endpoints, and the field names at read time need to be confirmed against a live fixture before we lock match logic. The fallback DOM-scrape path exists precisely to absorb this risk.

**Primary recommendation:** Build Check DMs as a new module `src/linkedin/check-dms.js` that runs its Voyager call via `page.evaluate(async () => fetch(...))` (same pattern as `getVoyagerDegree`), dumps the raw first-page response to a debug log on first run, then uses that log to finalize match-logic field names. Do NOT try to lock the schema from research alone — capture one real response as a test fixture (Wave 0 task) and use it as the contract.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Voyager HTTP call (auth cookies + CSRF) | Puppeteer page context | — | `page.evaluate(fetch)` inherits `li_at` + `JSESSIONID` cookies automatically — matches the existing `getVoyagerDegree` pattern in `src/linkedin/helpers.js`. Running `fetch` from Node would require extracting cookies, which we already decided against. |
| DOM-scrape fallback (inbox list) | Puppeteer page context | — | Same reason — needs an authenticated LinkedIn session. Only `puppeteer-core` running against a launched GoLogin profile has that. |
| Match logic (conversation → sheet row) | Node/Server (`src/linkedin/check-dms.js`) | — | Pure data transformation; no LinkedIn auth needed, no DOM. Keep it out of the page context so it's unit-testable. |
| Watermark persistence (`check-dms-state.json`) | Node/Server (`src/paths.js`) | — | Matches existing `state.json` / `history.json` pattern under `ORTUS_DATA_DIR`. Per-user, per-profile. |
| Sheet writeback (`Reply`, `Reply At`, `Reply Preview`) | Node/Server → Apps Script web app | — | Extend existing `ensureTrackingColumns` + `updateSheetRow` in `src/sheets-writer.js` + `google-apps-script.js`. No new endpoint. |
| Orchestration (multi-profile iteration) | Node/Server (`src/linkedin/check-dms.js`) | Reuses `src/gologin-launcher.js` | Follows the opening-loop structure in `src/campaign.js` — launch → health check → warmup → run scan → close. Do not fork or duplicate that loop. |
| Dashboard polling endpoint `/api/check-dms/status` | Node/Server (`server.js`) | — | Mirrors `/api/campaign/status` — single global status object, pollable every 2s. |
| Replies panel rendering | Browser (renderer — `public/js/app.js` + `public/index.html`) | — | Vanilla JS; no new dependency. |
| "Open Thread" → system browser | Electron main (already wired) | Renderer `<a target="_blank">` | `electron/main.js` line 96-102 already intercepts every `window.open`/`target="_blank"` with `shell.openExternal`. A plain `<a href="https://www.linkedin.com/messaging/thread/{id}/" target="_blank">` is sufficient — no IPC, no preload change. |

## Standard Stack

### Core (already in the project — nothing new installed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `puppeteer-core` | ^22.15.0 | Authenticated `page.evaluate(fetch)` calls + DOM scrape fallback | Already the driver for every LinkedIn interaction. No alternative needed. |
| `gologin` | 2.2.8 | Launches per-profile GoLogin browsers with correct cookies | Existing dependency. Multi-account scoping depends on this. |
| `express` | ^4.21.0 | `/api/check-dms/start`, `/api/check-dms/status`, `/api/check-dms/replies` endpoints | Same pattern as existing `/api/campaign/*` endpoints in `server.js`. |
| Google Apps Script web app | deployed | Sheet writeback (new `Reply`, `Reply At`, `Reply Preview` columns) | Existing pattern in `google-apps-script.js`. Extend `TRACKING_COLUMNS` + `FIELD_MAP`. |
| Electron `shell.openExternal` | 33.4.11 (already imported in `electron/main.js`) | Open LinkedIn thread in system browser | Already wired via `setWindowOpenHandler` — plain `<a target="_blank">` works. |

### Supporting (native to Node / already available)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:fs/promises` | built-in | Read/write `check-dms-state.json` watermark | Same pattern as `src/campaign.js` using `readFile`/`writeFile`. |
| `src/paths.js` `dataPath()` | local | Resolve state file under `ORTUS_DATA_DIR` | Mandatory — must not hard-code a path. |
| `src/utils.js` `extractSheetId` | local | Pass sheet ID to Apps Script | Same pattern as existing writes. |

### Alternatives Considered and Rejected

| Instead of | Could Use | Tradeoff / Why Not |
|------------|-----------|---------------------|
| `page.evaluate(async () => fetch())` | Node-side `fetch` with manually extracted cookies | Voyager requires the full `li_at` + `JSESSIONID` + `bcookie` stack; running in-page inherits all of them automatically and matches the battle-tested `getVoyagerDegree` pattern. [VERIFIED: src/linkedin/helpers.js:112-173] |
| `/voyager/api/messaging/conversationsV2` (if it exists) | `/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX` | The unofficial LinkedIn API libraries all use the LEGACY_INBOX variant — it is the well-documented shape. [CITED: nsandman/linkedin-api] A `conversationsV2` endpoint exists in some historical commits but is not what the community has standardized on. If our call 404s we can pivot, but start with `conversations?keyVersion=LEGACY_INBOX`. |
| GraphQL messaging endpoint (newer, paginationToken-based) | REST-li `start`+`count` on `/messaging/conversations` | The GraphQL path requires discovering query hashes that LinkedIn rotates. REST-li is more stable for our "low volume, one-shot" use case. [ASSUMED: GraphQL's rotation frequency is higher than REST-li's for messaging, based on community forum reports] |
| Separate "new Voyager module" | Extend `src/linkedin/helpers.js` with a `getConversationsPage()` helper | A dedicated `src/linkedin/check-dms.js` file keeps the orchestration + match logic co-located, and keeps `helpers.js` (which is imported by `outreach.js` during every lead) lean. |
| In-Electron thread viewer | `shell.openExternal` | Already locked by CONTEXT.md. `setWindowOpenHandler` in `electron/main.js` already redirects; plain `<a target="_blank">` works with zero plumbing. [VERIFIED: electron/main.js:96-102] |

### Installation

None required. Zero new npm dependencies.

**Version verification:** All dependencies are already pinned in `package.json`. No new installs — skip `npm view` step.

## Architecture Patterns

### System Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            RENDERER (public/js/app.js)                    │
│                                                                           │
│  [Check DMs button] ──click──►  POST /api/check-dms/start                 │
│                                  { profileIds: [...] }                    │
│                                                                           │
│  setInterval(2s) ────────────►  GET /api/check-dms/status                 │
│                                  { running, currentProfile, replies,      │
│                                    errors }                               │
│                                                                           │
│  Replies panel:                                                           │
│    for each reply:                                                        │
│      renderRow(name, snippet, time,                                       │
│                 <a target="_blank" href=https://linkedin.com/msg/thread>) │
│                                                 │                         │
└─────────────────────────────────────────────────┼─────────────────────────┘
                                                  │
                                       (Electron's setWindowOpenHandler
                                        intercepts → shell.openExternal →
                                        system browser with LinkedIn cookies)
                                                  │
┌──────────────────────────────────────────────────────────────────────────┐
│                            SERVER (server.js + src/)                      │
│                                                                           │
│  POST /api/check-dms/start ──►  startCheckDms({ profileIds })             │
│                                    │                                      │
│                                    ▼                                      │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  src/linkedin/check-dms.js                                         │  │
│  │                                                                     │  │
│  │  1. Load watermark from dataPath('check-dms-state.json')            │  │
│  │  2. Fetch sheet rows via sheets.js::fetchSheet(sheetUrl)            │  │
│  │     └─ Filter: Message="sent" AND Account Used = <running profile>  │  │
│  │  3. For each profileId (sequential):                                │  │
│  │       a. launchProfile() — gologin-launcher.js                      │  │
│  │       b. Load linkedin.com/feed/ → checkProfileHealth (reused)      │  │
│  │       c. Voyager scan via page.evaluate:                            │  │
│  │            fetch('/voyager/api/messaging/conversations?             │  │
│  │                   keyVersion=LEGACY_INBOX&count=20&start=0')        │  │
│  │       d. Parse response → extract conversations[] with              │  │
│  │            { entityUrn, participants, lastMessage, createdAt }      │  │
│  │       e. If non-2xx OR parse fails → DOM scrape fallback            │  │
│  │       f. Match conversations → sheet rows by firstName+lastName     │  │
│  │            (tiebreak: LinkedIn URL if present)                      │  │
│  │       g. Filter replies: lastMessageAt > watermark[profile]         │  │
│  │       h. Short-circuit pagination when page.last < watermark        │  │
│  │       i. For each match: updateSheetRow({ reply:'yes',              │  │
│  │            replyAt, replyPreview })                                 │  │
│  │            (skip if existing Reply='yes' — non-destructive)         │  │
│  │       j. Push into global checkDms.replies[]                        │  │
│  │       k. closeProfile()                                             │  │
│  │  4. On ALL profiles successful → update watermark[profile]=startTS  │  │
│  │     (NOT per-profile — atomic batch to avoid partial advances)      │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                    │                                      │
│                                    ▼                                      │
│  src/sheets-writer.js  ──POST──►  Apps Script web app                     │
│    ensureTrackingColumns()          (extended TRACKING_COLUMNS with        │
│    updateSheetRow()                  Reply / Reply At / Reply Preview)    │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Recommended File Structure

```
src/
├── linkedin/
│   ├── helpers.js         # (unchanged) — reference: getVoyagerDegree auth pattern
│   ├── outreach.js        # (unchanged)
│   ├── actions.js         # (unchanged)
│   └── check-dms.js       # NEW — all reply-scanning orchestration + match logic
├── campaign.js            # (unchanged)
├── sheets-writer.js       # EXTEND — add reply, replyAt, replyPreview to FIELD_MAP comment/helper
├── sheets.js              # (unchanged) — used to fetch rows
├── paths.js               # (unchanged) — dataPath('check-dms-state.json')
└── gologin-launcher.js    # (unchanged) — reused for profile launch/close

server.js                  # EXTEND — 3 new endpoints: /api/check-dms/{start,status,replies}
google-apps-script.js      # EXTEND — TRACKING_COLUMNS += ['Reply','Reply At','Reply Preview']
                           #        — FIELD_MAP += { reply, replyAt, replyPreview }

electron/main.js           # (unchanged) — existing setWindowOpenHandler does the work

public/
├── index.html             # EXTEND — add "Check DMs" button in Campaign section,
│                           #          add Replies panel markup (hidden until populated)
├── js/app.js              # EXTEND — startCheckDms(), pollCheckDmsStatus(), renderReplies()
└── css/style.css          # EXTEND — Replies panel styles (monochrome, hairline borders,
                           #          no accent color except functional green/red)
```

### Pattern 1: Voyager-in-page-evaluate (the load-bearing primitive)

**What:** Run an authenticated `fetch()` call inside the Puppeteer page context so it inherits all cookies and the CSRF token from the JSESSIONID cookie.

**When to use:** Every authenticated LinkedIn REST call. This is already the blessed pattern for degree-badge detection (`getVoyagerDegree`).

**Example (adapt for messaging):**
```javascript
// Source: src/linkedin/helpers.js:112-164 (existing pattern)
export async function getConversationsPage(page, { start = 0, count = 20 } = {}) {
  return page.evaluate(async ({ start, count }) => {
    try {
      // CSRF token from JSESSIONID cookie — LinkedIn requires this even on GETs
      const csrf = document.cookie.split(';')
        .map(c => c.trim())
        .find(c => c.startsWith('JSESSIONID='));
      if (!csrf) return { ok: false, error: 'no_jsessionid' };
      const token = csrf.split('=')[1]?.replace(/"/g, '');

      const url = `https://www.linkedin.com/voyager/api/messaging/conversations`
        + `?keyVersion=LEGACY_INBOX&count=${count}&start=${start}`;

      const resp = await fetch(url, {
        headers: {
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': token,
          'x-restli-protocol-version': '2.0.0',
          'x-li-lang': 'en_US',
        },
        credentials: 'include',
      });

      if (!resp.ok) return { ok: false, status: resp.status, url };
      const data = await resp.json();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }, { start, count });
}
```

Notes on headers:
- `accept: application/vnd.linkedin.normalized+json+2.1` — matches the working `getVoyagerDegree` call [VERIFIED: src/linkedin/helpers.js:132].
- `csrf-token` from `JSESSIONID` cookie — mandatory, LinkedIn 401s without it.
- `x-restli-protocol-version: 2.0.0` — REST-li protocol version, required by Voyager endpoints [VERIFIED: src/linkedin/helpers.js:134] [CITED: nsandman/linkedin-api client.py default headers].
- `x-li-lang: en_US` — not strictly required but present in the unofficial client; harmless to include [CITED: nsandman/linkedin-api].
- `credentials: 'include'` — without this the browser omits cookies on cross-origin fetches (though same-origin here, safe to keep).

### Pattern 2: Match logic (conversation ↔ sheet row)

**What:** Pure function that takes `(conversations, candidateRows)` and returns matched pairs.

**When to use:** Separate from the Voyager call so it's unit-testable with a fixture.

**Example:**
```javascript
// src/linkedin/check-dms.js — pure, no side effects
function normalizeName(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function matchConversation(conv, candidates) {
  const participant = extractOtherParticipant(conv); // { firstName, lastName, profileUrn }
  const pFull = `${normalizeName(participant.firstName)} ${normalizeName(participant.lastName)}`;
  if (!pFull.trim()) return { matched: false, reason: 'no_participant_name' };

  const hits = candidates.filter(row => {
    const rFull = `${normalizeName(row.firstName)} ${normalizeName(row.lastName)}`;
    return rFull === pFull;
  });

  if (hits.length === 0) return { matched: false, reason: 'no_candidate_row' };
  if (hits.length === 1) return { matched: true, row: hits[0] };

  // Tiebreak by LinkedIn URL if the conversation's profile URN resolves to a public id
  // that matches a row's stored LinkedIn URL slug.
  if (participant.publicIdentifier) {
    const urlHit = hits.find(r =>
      (r.linkedinUrl || '').toLowerCase().includes(`/in/${participant.publicIdentifier.toLowerCase()}`)
    );
    if (urlHit) return { matched: true, row: urlHit };
  }

  return { matched: false, reason: 'ambiguous', candidates: hits.length };
}
```

### Pattern 3: Atomic watermark advance

**What:** Only advance `last_check_at` for a profile AFTER its scan completes successfully. Capture the run's start time at the beginning and apply it at the end.

**Why:** If the scan fails mid-way, the operator retries and doesn't miss replies that arrived during the failed run.

```javascript
// src/linkedin/check-dms.js
async function scanOneProfile(profileId, profileName, sheetUrl, watermarkBefore) {
  const runStartIso = new Date().toISOString(); // capture BEFORE the scan
  const replies = await doVoyagerScan(/* ... */);
  // ...writeback...
  // Only if we get here (no throw) do we return the new watermark:
  return { profileName, replies, newWatermark: runStartIso };
}

// Top level:
const results = [];
for (const p of profileIds) {
  try {
    const r = await scanOneProfile(p.id, p.name, sheetUrl, state[p.name]?.last_check_at);
    results.push(r);
  } catch (err) {
    // Do NOT push a newWatermark — this profile's watermark stays unchanged
    results.push({ profileName: p.name, error: err.message });
  }
}
// Atomic write at the end:
for (const r of results) {
  if (r.newWatermark) state[r.profileName] = { last_check_at: r.newWatermark };
}
await writeFile(dataPath('check-dms-state.json'), JSON.stringify(state, null, 2));
```

### Pattern 4: "Open Thread" external browser (zero-plumbing)

**What:** Plain anchor tags with `target="_blank"` open in system browser because of the existing `setWindowOpenHandler` in `electron/main.js`.

```html
<!-- Inside Replies panel row -->
<a class="btn btn-secondary btn-sm"
   href="https://www.linkedin.com/messaging/thread/2-ZDdkM2M0MDUt.../"
   target="_blank"
   rel="noopener noreferrer">
  Open Thread
</a>
```

No IPC, no preload change, no `contextBridge`. Verified [VERIFIED: electron/main.js:96-102]:
```js
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  if (url.startsWith('http')) {
    shell.openExternal(url);
    return { action: 'deny' };
  }
  return { action: 'allow' };
});
```

### Anti-Patterns to Avoid

- **Do NOT re-implement profile launch/health-check loop.** Extract/reuse the existing logic from `src/campaign.js`. If refactoring is needed to share, lift the loop into a small helper (`src/profile-session.js`) — but do not duplicate.
- **Do NOT extract cookies and call Voyager from Node.** The authenticated-fetch-in-page pattern is the entire reason the degree check is reliable. Matching that pattern is non-negotiable.
- **Do NOT call Voyager while a campaign is running on the same profile.** The per-profile browser is a single cookie jar; two puppeteer flows racing will trip LinkedIn's bot detection. Server-side guard: refuse `/api/check-dms/start` while `campaign.running === true`.
- **Do NOT use `innerHTML` with conversation text from LinkedIn** when rendering the Replies panel — prospects may have `<script>`-shaped content in their messages. Use `textContent` or DOM APIs. (The existing codebase has places using `innerHTML` — Replies panel must avoid the pattern for reply bodies specifically.)
- **Do NOT overwrite `Reply="yes"` rows.** The Apps Script `writeFields` function currently overwrites any mapped field. You must either (a) add a server-side pre-check (read row via `getStatus`, skip if `Reply="yes"`), or (b) add a `skipIfSet` option to the Apps Script action. The server-side read-before-write is simpler and already has precedent — prefer (a).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Authenticated fetch to LinkedIn | Custom cookie extractor + Node fetch | `page.evaluate(async () => fetch())` inside the Puppeteer page | Already solved in `getVoyagerDegree`. Cookie extraction is fragile (CSRF rotates). |
| Sheet column management | Direct Google Sheets API client | Extend `google-apps-script.js` `TRACKING_COLUMNS` array | The Apps Script path is the only writeback channel this project has. Adding another Google client means OAuth tokens, quotas, secrets — wrong direction. |
| CSV parsing | Any npm CSV library | `src/sheets.js::fetchSheet` | Already handles quoted fields with commas and newlines. |
| Per-user state dir | New config / ENV var / hardcoded path | `src/paths.js::dataPath(...)` | Exists for exactly this reason. Electron sets `ORTUS_DATA_DIR`; CLI uses `./data`. |
| Status polling | WebSockets, Server-Sent Events | `setInterval(2000)` polling `/api/check-dms/status` | Matches `/api/campaign/status` pattern (`public/js/app.js:1237`). Simpler, already works. |
| Profile launch/close | New gologin wrapper | `src/gologin-launcher.js::{launchProfile, closeProfile}` | Same driver as campaign, same health patterns. |
| Health check | Write a new one | Reuse or extract from `src/campaign.js::checkProfileHealth` | Already handles login/authwall/rate-limit banners. |
| External link opening | IPC bridge, `contextBridge.exposeInMainWorld` | `<a target="_blank">` with existing `setWindowOpenHandler` | Already wired in `electron/main.js`. Zero new plumbing. |

**Key insight:** Every primitive Check DMs needs already exists. The value of this phase is _composition_, not invention. The only new code should be (1) the `src/linkedin/check-dms.js` module, (2) three tiny Express endpoints, (3) the Apps Script column additions, and (4) the Replies panel UI. If a task is adding new infrastructure, stop and check whether you can lean on an existing pattern instead.

## Runtime State Inventory

Not applicable — Phase 11 is additive (new columns, new state file, new module). No renames, no migrations, no string replacements across the codebase.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — all new fields are additive | Apps Script `ensureColumns` will auto-add `Reply`, `Reply At`, `Reply Preview` on first run. First run per operator creates `check-dms-state.json` from scratch — empty initial watermark. |
| Live service config | None — no change to GoLogin, Apps Script deployment, or environment | — |
| OS-registered state | None | — |
| Secrets/env vars | None — reuses existing `SHEETS_WEBAPP_URL`, `ORTUS_DATA_DIR`, GoLogin token | No new secrets. |
| Build artifacts | None — no package.json changes | — |

## Common Pitfalls

### Pitfall 1: Voyager endpoint 404 or schema drift

**What goes wrong:** LinkedIn occasionally reshapes Voyager endpoints (`/conversations` → `/conversationsV2` → GraphQL). A quiet 404 means zero replies surface — and nothing looks broken.
**Why it happens:** Endpoints are internal, undocumented, and rotated on LinkedIn's schedule.
**How to avoid:**
- Log the HTTP status and first 500 chars of response on every Voyager call (not just on failure).
- If the response is a 404 or an HTML login redirect, trip the fallback immediately.
- Add a Wave 0 task: capture one real response payload into `tests/fixtures/voyager-conversations-page.json` and lock the parser against that fixture.
**Warning signs:** `repliesFound: 0` across all profiles even though the operator knows they have unread DMs. Logs showing `ok: false, status: 404` or HTML text starting with `<!DOCTYPE`.

### Pitfall 2: Name-collision false matches

**What goes wrong:** Two prospects named "David Kim" in the sheet → ambiguous match → either (a) both get marked with the same reply (wrong) or (b) neither gets matched (misses real reply).
**Why it happens:** Not everyone has a stored LinkedIn URL on their sheet row.
**How to avoid:**
- When `matchConversation` returns `ambiguous`, mark the Replies panel row with a "? ambiguous" tag and do NOT write back to the sheet for that conversation. Log it so the operator can disambiguate manually. [from CONTEXT.md open questions — decided].
- Populate the Voyager tiebreak: if the conversation payload includes a `publicIdentifier` or `profileUrn`, use it.
**Warning signs:** A reply appearing twice on the same sheet, or a known reply not appearing at all.

### Pitfall 3: Watermark advance on partial failure

**What goes wrong:** Profile A scans successfully, Profile B errors halfway through. If the code naively advances both watermarks, replies that arrived during Profile B's half-run get silently skipped on the next run.
**Why it happens:** Looping and writing state inside the loop instead of after the loop.
**How to avoid:** Apply Pattern 3 above — collect `newWatermark` only on success, apply atomically at the end.
**Warning signs:** Operator retries Check DMs and still misses replies they know they have.

### Pitfall 4: Overwriting operator's manual `Reply` edits

**What goes wrong:** Operator manually edits `Reply Preview` on a row (e.g., to add context). Next scan re-writes that cell with a stale snippet.
**Why it happens:** `updateSheetRow`'s `writeFields` unconditionally sets mapped fields.
**How to avoid:** Before writing, server-side read the row via `getStatus` (existing Apps Script action) and skip writeback if `Reply` is already `"yes"`. Alternative: add a `skipIfSet: ['reply']` option to the Apps Script — same effect, one fewer round trip, but more Apps Script to change. Recommend the server-side pre-check for simplicity.
**Warning signs:** Operator complains "my edits disappeared".

### Pitfall 5: Running Check DMs concurrently with a campaign on the same profile

**What goes wrong:** Two Puppeteer sessions on one GoLogin profile → browser state conflicts → both flows fail, or worse, LinkedIn flags the account.
**Why it happens:** The `campaign.running` guard exists for `startCampaign` but there's no shared mutex with a new `startCheckDms`.
**How to avoid:** In `/api/check-dms/start`, explicitly check `campaign.running` and return 409 if true. Similarly, `startCheckDms` sets its own `checkDms.running = true` flag and `/api/campaign/start` should check it.
**Warning signs:** "Stale frame detected" / "Protocol error" messages mid-scan. Profile shows login wall after the scan.

### Pitfall 6: Rate-limited (429) scan silently returns empty

**What goes wrong:** Voyager returns 429, our Voyager code returns `{ ok: false, status: 429 }`, fallback DOM scrape is ALSO rate-limited (different endpoint but same cookie), and the operator sees "0 replies" with no visible error.
**Why it happens:** Both paths fail for the same reason.
**How to avoid:** Surface the failure in the Replies panel as an error row, not an empty panel. CONTEXT.md spec already calls for this — enforce it in the UI code: if `status.errors.length > 0`, render a prominent error tile BEFORE the replies list, and advise a retry window (10-15 min).
**Warning signs:** Multiple consecutive scans return zero replies even when operator knows there should be new DMs. Errors array non-empty but panel looks empty.

### Pitfall 7: Pagination infinite loop

**What goes wrong:** Voyager returns a non-sorted page, or `lastActivityAt` is missing on some entries, and the short-circuit-on-older-than-watermark check never fires.
**Why it happens:** Messy payloads. Also: the absolute first run has no watermark at all — scanning "all conversations" for a chatty operator could be thousands of pages.
**How to avoid:**
- Hard cap: MAX_PAGES = 20 (each page = 20 conversations, so 400-conversation ceiling per profile per run). Log a warning if hit.
- Stop pagination when the page returns fewer than `count` conversations (natural end).
- On first run (no watermark), scan only the first `MAX_FIRST_RUN_PAGES = 5` and log "first run — showing recent replies only; re-run to capture older if needed" — chatty operators don't need 1000 old conversations retroactively flooding their sheet.
**Warning signs:** Scan takes >30s for one profile. Logs show page 15, 16, 17...

## Code Examples

### Example 1: Full Voyager scan with short-circuit pagination

```javascript
// src/linkedin/check-dms.js
import { getConversationsPage } from './helpers.js'; // new helper, Pattern 1 above

const MAX_PAGES = 20;
const PAGE_SIZE = 20;

async function voyagerScan(page, watermarkIso) {
  const watermarkMs = watermarkIso ? Date.parse(watermarkIso) : 0;
  const conversations = [];
  let start = 0;
  let pagesFetched = 0;

  while (pagesFetched < MAX_PAGES) {
    const res = await getConversationsPage(page, { start, count: PAGE_SIZE });
    if (!res.ok) {
      // Return what we have + an error tag; caller decides fallback
      return { ok: false, error: res.error || `http_${res.status}`, partial: conversations };
    }

    const pageConvs = extractConversationsArray(res.data); // adapter layer — see Wave 0
    if (pageConvs.length === 0) break;

    conversations.push(...pageConvs);
    pagesFetched++;

    // Short-circuit: if the oldest conv on this page is still older than watermark,
    // subsequent pages are even older — stop.
    const oldestOnPage = Math.min(...pageConvs.map(c => c.lastActivityAtMs).filter(Number.isFinite));
    if (watermarkMs && Number.isFinite(oldestOnPage) && oldestOnPage < watermarkMs) break;

    if (pageConvs.length < PAGE_SIZE) break; // natural end of inbox
    start += PAGE_SIZE;
  }

  return { ok: true, conversations, pagesFetched };
}
```

### Example 2: Extending Apps Script tracking columns

```javascript
// google-apps-script.js — lines 31-39, extend:
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

// FIELD_MAP — lines 57-65, extend:
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

Note: the Reply columns are NOT in `ACTION_COLUMNS` (the dash-filled set — OP, Message, InMail). Reply columns left empty are fine; they don't need the `—` filler.

### Example 3: Dashboard polling endpoint + renderer (pattern copy)

```javascript
// server.js — new endpoints (after /api/campaign/status block around line 316):
app.post('/api/check-dms/start', (req, res) => {
  if (campaign.running) {
    return res.status(409).json({ error: 'Cannot check DMs while a campaign is running' });
  }
  const { profileIds, sheetUrl, linkedinColumn } = req.body;
  if (!profileIds?.length) return res.status(400).json({ error: 'profileIds required' });
  if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

  startCheckDms({ profileIds, sheetUrl, linkedinColumn: linkedinColumn || '' })
    .catch(err => console.error('Check DMs error:', err.message));

  res.json({ ok: true, message: 'Check DMs started' });
});

app.get('/api/check-dms/status', (_req, res) => {
  res.json(getCheckDmsStatus());
});

app.get('/api/check-dms/replies', (_req, res) => {
  res.json({ replies: getCheckDmsReplies() });
});
```

```javascript
// public/js/app.js — new functions (match existing pattern ~line 1246):
async function startCheckDms() {
  if (selectedProfileIds.length === 0) { alert('Select at least one profile first.'); return; }
  const sheetUrl = document.getElementById('sheet-url').value.trim();
  if (!sheetUrl) { alert('Enter a Google Sheet URL.'); return; }
  try {
    const res = await fetch('/api/check-dms/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds: selectedProfileIds, sheetUrl, linkedinColumn: document.getElementById('linkedin-col-select')?.value || '' }),
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    startCheckDmsPolling();
  } catch (err) { alert(`Failed: ${err.message}`); }
}

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
    renderCheckDmsStatus(s);
    if (!s.running && checkDmsPollInterval) {
      clearInterval(checkDmsPollInterval); checkDmsPollInterval = null;
      const r = await fetch('/api/check-dms/replies').then(r => r.json());
      renderRepliesPanel(r.replies);
    }
  } catch { /* transient */ }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `/voyager/api/messaging/conversations` (REST-li) | Still the community-standard endpoint | — | What we're using. [CITED: nsandman/linkedin-api, tomquirk/linkedin-api] |
| REST-li `start` + `count` pagination | GraphQL `paginationToken` for newer endpoints | 2023-2024 rollout | Voyager REST-li messaging endpoints still work as of community reports in 2025. We use REST-li for stability. [ASSUMED: that the REST-li messaging endpoint will remain stable through Phase 11 development and ~6 months of use. Trip wire: first-run 404s in field. Mitigation: DOM-scrape fallback, which does not depend on the API.] |
| Manual cookie extraction | `page.evaluate(fetch)` | Already our pattern | `getVoyagerDegree` in `src/linkedin/helpers.js` is the proof point. |
| Page-based polling every few minutes | Manual "morning ritual" triggered scan | Decided in CONTEXT.md | Reduces rate-limit exposure. One scan per operator per morning is <10 API calls total. |

**Deprecated / outdated:**
- **v1 LinkedIn developer API messaging endpoints** (`developer.linkedin.com/docs/v1/communications/reading-members-mailbox`) — fully deprecated, not accessible for non-partner apps. Do not even look there. [VERIFIED: learn.microsoft.com/en-us/linkedin/shared/integrations/communications/overview shows only partner-only access.]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX` endpoint still returns a paginated list of conversations in 2026 | Pattern 1 / Summary | Check DMs returns zero results. Mitigated by the DOM-scrape fallback decided in CONTEXT.md — we degrade gracefully. Wave 0 validation task will confirm. |
| A2 | The Voyager response field names include something like `lastActivityAt` or `events[].createdAt` (Unix ms) | Pattern 1 / Example 1 | Match logic reads wrong field. Mitigated by the Wave 0 "dump one live response to a fixture" task — we finalize names from the fixture, not from assumption. |
| A3 | The `entityUrn` prefix for conversations is `urn:li:fs_conversation:{threadId}` and the web thread URL is `linkedin.com/messaging/thread/{threadId}/` | Specifics / Open Thread button | "Open Thread" 404s. Low impact (operator can navigate manually). Confirmable from the live fixture. |
| A4 | LinkedIn's REST-li messaging endpoint pagination accepts `start`/`count` query params (not `createdBefore` cursor) | Pattern 1 | Pagination silently doesn't paginate — we always read the first 20 conversations. Mitigated by the `MAX_FIRST_RUN_PAGES = 5` cap (reasonable even with single-page truncation). |
| A5 | A conversation payload includes the participant's `firstName` / `lastName` or `name` field directly (not just a URN requiring a second lookup) | Match logic | Would force a second round-trip per conversation to resolve names → 20× more API calls. If true, revisit the matching strategy (batch miniProfile lookups exist in Voyager). Check in Wave 0 fixture. |
| A6 | REST-li messaging endpoint is not covered by LinkedIn's typical 100-connection-request weekly cap (it's a read endpoint, not a write) | Rate limiting | Low confidence — no official documentation. Mitigated by: (a) low call volume (~5 pages per profile per morning), (b) falling back to DOM scrape if 429. Monitor in production; if 429s appear, add delay between pages. |
| A7 | Operators have low enough conversation volume that 5 first-run pages (100 conversations) is sufficient coverage | Pitfall 7 | Very chatty operators might miss old pre-existing replies on first run. Acceptable — the "only new since watermark" model is the product goal; first run surfaces "recent", not "historical". Operator can re-run to catch up. |

**If this table has entries:** All assumed claims should be validated either in Wave 0 (schema) or flagged for user confirmation during `/gsd-discuss-phase` follow-up. A1, A2, A3, A5 are testable via a single live-fixture capture task — consolidate into one Wave 0 task.

## Open Questions (resolved by this research, for the record)

1. **Voyager endpoint + query params** — Use `/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&start=N&count=20`. The `conversationsV2` variant exists in some forks but is not what community libraries standardize on. [CITED: nsandman/linkedin-api, tomquirk/linkedin-api]

2. **Auth headers** — Minimum set: `csrf-token` (from `JSESSIONID` cookie), `x-restli-protocol-version: 2.0.0`, `accept: application/vnd.linkedin.normalized+json+2.1`, `credentials: 'include'`. Optional but harmless: `x-li-lang: en_US`, `user-agent` (handled by Puppeteer). [VERIFIED: src/linkedin/helpers.js:128-138] [CITED: nsandman/linkedin-api client.py]

3. **Pagination stop condition** — Yes, short-circuit when the page's oldest `lastActivityAt` is older than the watermark. Conversations are sorted by last-activity DESC by default in LinkedIn inboxes (the "Recents" view). If the scan runs while the operator's inbox is on an unsorted filter, the short-circuit may stop early and miss a conversation — but `MAX_FIRST_RUN_PAGES` + subsequent re-runs catch anything missed. [ASSUMED: sort order is stable; tested informally in unofficial client docs]

4. **Name collision** — Log + skip + surface a `? ambiguous` row in the Replies panel. Do NOT write anything to the sheet for ambiguous conversations. Operator sees the row and can disambiguate manually. This matches the CONTEXT.md leaning.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js (ESM) | `src/linkedin/check-dms.js` | ✓ (already running) | per package.json `type: "module"` | — |
| `puppeteer-core` | Voyager `page.evaluate`, DOM scrape | ✓ | 22.15.0 | — |
| `gologin` SDK | Profile launch | ✓ | 2.2.8 | — |
| Google Apps Script web app | Sheet writeback | ✓ (deployed) | existing `SHEETS_WEBAPP_URL` | — |
| Active LinkedIn session per GoLogin profile | Voyager auth | runtime-dependent | — | Existing health-check + re-login flow in `src/campaign.js::checkProfileHealth` handles this |
| Electron `shell.openExternal` | Open Thread button | ✓ (wired via `setWindowOpenHandler`) | 33.4.11 | In browser dev mode (non-Electron), `target="_blank"` opens a new tab — acceptable degrade |

**Missing dependencies with no fallback:** None — everything required is already present.

**Missing dependencies with fallback:** None — the only runtime failure mode (LinkedIn session expired) is already handled by the existing profile health-check loop.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | None currently in `package.json`. Recommend `node --test` (Node built-in test runner) — zero new dependencies, matches the project's "no new deps unless justified" constraint. |
| Config file | None needed — `node --test` finds `tests/**/*.test.js` by convention. |
| Quick run command | `node --test tests/check-dms.test.js` |
| Full suite command | `node --test tests/**/*.test.js` |

Rationale for `node --test`: Jest / Vitest would add transitive dependencies (and transform overhead given `"type": "module"`). Node's built-in test runner has been stable since Node 20; supports `describe`/`it`, mocking, and JSON output. No package.json changes required, only a `"test": "node --test tests/**/*.test.js"` script entry.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DMS-01 | "Check DMs" button in Campaign section triggers scan | UI smoke (DOM present + POST /api/check-dms/start fires) | `node --test tests/ui/check-dms-button.test.js` | ❌ Wave 0 |
| DMS-02 | Per-profile scoping — only rows with `Message="sent"` AND `Account Used=<profile>` | Unit (filter function on fixture rows) | `node --test tests/check-dms-filter.test.js` | ❌ Wave 0 |
| DMS-03 | Primary Voyager call + fallback DOM scrape — correct params sent, failure → fallback | Unit + integration: assert URL + headers on a mocked page; assert fallback triggers on non-2xx | `node --test tests/check-dms-voyager.test.js` | ❌ Wave 0 |
| DMS-04 | Sheet writeback — `Reply`, `Reply At`, `Reply Preview` columns auto-added; non-destructive on existing `Reply="yes"` | Integration (mocked Apps Script web app); unit (skipIfSet logic) | `node --test tests/check-dms-writeback.test.js` | ❌ Wave 0 |
| DMS-05 | Replies panel renders name, snippet, timestamp, Open Thread button from status payload | UI smoke (render function on fixture response produces expected DOM) | `node --test tests/ui/replies-panel.test.js` | ❌ Wave 0 |
| DMS-06 | Open Thread button opens external browser (not inside Electron window) | **Manual-only** — automated verification requires Electron spawn + window inspection. Document the manual step in 11-VALIDATION.md: "Click Open Thread → confirm it opens in system browser, not Electron." | Manual | N/A |
| DMS-07 | Watermark: only replies newer than `last_check_at` per profile surface | Unit (filter by watermark timestamp on fixture conversations) + integration (state file written atomically after all profiles succeed, not during loop) | `node --test tests/check-dms-watermark.test.js` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `node --test tests/check-dms-*.test.js` (excludes UI — runs in < 3s)
- **Per wave merge:** `node --test tests/**/*.test.js` (includes UI smoke — still < 10s with jsdom)
- **Phase gate (before `/gsd-verify-work`):** Full suite green + manual DMS-06 verification completed in Electron dev build (`npm run electron:dev`) + one live end-to-end run against a real GoLogin profile with at least one known reply in the sheet.

### Nyquist Sampling Points (where we verify the signal)

The "signal" here is "a real LinkedIn reply surfaces correctly in both UI and sheet." Sample at these points along the pipeline:

1. **Voyager response parse** — fixture-driven. Capture one real response payload in Wave 0 (`tests/fixtures/voyager-conversations-real.json`), assert our parser extracts `{ participantFirstName, participantLastName, lastMessage, lastActivityAt, entityUrn }` from it. Failure = schema drift detected before prod.
2. **Match logic** — pure-function test. Given `(conversations, candidateRows)` fixtures, assert matches/misses/ambiguous buckets are correct.
3. **Watermark filter** — unit test with timestamp fixtures: conversations before/after watermark → correct subset surfaces.
4. **Non-destructive writeback** — mock Apps Script; assert that when a row's `Reply` is already `"yes"` we do NOT send an update payload.
5. **Atomic watermark advance** — simulate "Profile B throws" in a 2-profile test; assert Profile A's watermark advances but Profile B's does not.
6. **UI render** — jsdom or happy-dom + Node test: given a `replies` payload, `renderRepliesPanel(el, replies)` produces DOM with correct text and `<a target="_blank">` links.
7. **End-to-end smoke (manual)** — one real profile, one real sheet row with a real DM reply on LinkedIn. Verify: (a) button triggers scan; (b) reply shows in panel; (c) sheet `Reply`/`Reply At`/`Reply Preview` populated; (d) Open Thread opens in system browser; (e) re-run shows no replies (watermark advanced).

### Wave 0 Gaps

- [ ] `tests/fixtures/voyager-conversations-real.json` — **critical** — one live response payload captured by running a throwaway script against Antonio's GoLogin profile. Everything else depends on this.
- [ ] `tests/fixtures/sheet-rows-with-sent-dms.json` — mock sheet row set covering: per-profile filter, match hits, name collisions (with + without LinkedIn URL), rows with existing `Reply="yes"`.
- [ ] `tests/check-dms-filter.test.js` — DMS-02 coverage (per-profile filter).
- [ ] `tests/check-dms-voyager.test.js` — DMS-03 coverage (Voyager URL + headers + fallback trigger).
- [ ] `tests/check-dms-match.test.js` — match logic (match hits, ambiguous, LinkedIn-URL tiebreak).
- [ ] `tests/check-dms-watermark.test.js` — DMS-07 coverage (filter by watermark, atomic advance on success).
- [ ] `tests/check-dms-writeback.test.js` — DMS-04 coverage (column ensure, non-destructive skip).
- [ ] `tests/ui/replies-panel.test.js` — DMS-05 coverage (happy-dom or jsdom; zero-install if using `happy-dom` as a minimal devDep — justify or skip).
- [ ] `tests/ui/check-dms-button.test.js` — DMS-01 coverage (button presence in index.html, onclick wired).
- [ ] `"test": "node --test tests/**/*.test.js"` script entry in `package.json`.
- [ ] `11-VALIDATION.md` manual DMS-06 step documented.

**Optional but recommended:** `tests/fixtures/voyager-conversations-DEGRADED.json` — a hand-crafted payload with missing/null fields (no `firstName`, `lastActivityAt: null`, malformed URN) so parser resilience is tested without waiting for LinkedIn to misbehave in production.

## Project Constraints (from CLAUDE.md)

- **Runtime:** Node with ESM (`"type": "module"`) — no CommonJS-only dependencies. The project's primary focus described in CLAUDE.md is the ElevenLabs calling integration (Google Apps Script); Phase 11 is a parallel LinkedIn workstream in the same repo — no conflicts but the GSD Workflow Enforcement rule applies (use `/gsd:*` commands, no direct edits).
- **GSD Workflow Enforcement:** All file edits for Phase 11 must go through `/gsd:execute-phase` (or explicit user bypass). Research ends here; plan → execute flow takes over.
- **No new npm dependencies unless strongly justified** (from phase CONTEXT): Phase 11 adds zero new production deps. One candidate devDep (`happy-dom` or `jsdom`) for UI tests — justify or drop in the plan.
- **Preserve all core automation logic** (from STATE.md decisions): campaign orchestrator, LinkedIn actions, GoLogin launcher, sheet read/write MUST NOT be modified. Check DMs extends non-destructively — new module, extensions to existing `TRACKING_COLUMNS`/`FIELD_MAP`, new endpoints. No changes to `src/campaign.js`, `src/linkedin/outreach.js`, `src/linkedin/actions.js`, `src/gologin-launcher.js`, `src/sheets.js`, `src/sheets-writer.js` core logic (but extending configuration arrays/maps is allowed and expected).
- **"Command deck" monochrome aesthetic:** Replies panel CSS must use `var(--bg)`/`var(--ink)`/`var(--gray)`/`var(--hairline)`. No new accent colors. Use `--green` / `--red` only for functional states (success/error). Typography: `var(--display)` for headlines, `var(--mono)` for labels. Button radii: 0 or 9999 only.
- **`shell.openExternal` MUST be used for Open Thread** — handled by the existing `setWindowOpenHandler` via plain `<a target="_blank">`. No IPC bridging.
- **Non-destructive sheet writeback** — never overwrite `Reply="yes"`.
- **Watermark only advances on successful scan completion** — Pattern 3 above.

## Sources

### Primary (HIGH confidence — verified in code/docs)
- `src/linkedin/helpers.js:112-173` — `getVoyagerDegree` — the exact auth pattern Check DMs must copy (CSRF from JSESSIONID, `x-restli-protocol-version`, accept header, `credentials: 'include'`).
- `src/campaign.js:296-332, 349-500, 864-886` — profile filtering, round-robin launch, health check, browser close. Check DMs orchestration follows this shape.
- `src/sheets-writer.js:67-87, 96-121` — `ensureTrackingColumns`, `updateSheetRow`. Extended for Reply columns.
- `google-apps-script.js:31-39, 57-65, 128-204, 315-369, 530-579` — `TRACKING_COLUMNS`, `FIELD_MAP`, `handleEnsureColumns`, `handleUpdateRow`, `writeFields`. Columns get added here.
- `electron/main.js:96-102` — `setWindowOpenHandler` → `shell.openExternal`. Confirms `<a target="_blank">` is sufficient for Open Thread.
- `src/paths.js:1-23` — `dataPath()` helper; location for `check-dms-state.json`.
- `package.json` — confirms zero new deps are needed for core functionality.

### Secondary (MEDIUM confidence — cross-verified community libraries)
- [nsandman/linkedin-api — Voyager messaging endpoint](https://github.com/nsandman/linkedin-api) — confirms `/messaging/conversations?keyVersion=LEGACY_INBOX` is the community standard and REST-li `start`/`count` pagination is what's used. Client headers confirm `x-restli-protocol-version: 2.0.0` is a default.
- [tomquirk/linkedin-api (PyPI)](https://pypi.org/project/linkedin-api/) — same endpoint confirmed via a second implementation.
- [REST-li Protocol pagination spec](https://linkedin.github.io/rest.li/spec/protocol) — confirms `start`+`count` as the standard pagination envelope, and the `links` field in responses.
- [LinkedIn Communication APIs (Microsoft Learn)](https://learn.microsoft.com/en-us/linkedin/shared/integrations/communications/overview) — confirms the official `/v1/communications/*` API is partner-only, not usable for this project.

### Tertiary (LOW confidence — flagged for validation)
- Voyager response exact schema (field names for participant name, last message body, last-activity timestamp, entity URN prefix). The unofficial libraries reference these but formats have shifted. **Validated by Wave 0 fixture-capture task.**
- Voyager messaging endpoint rate-limit behavior (429 frequency at ~5 calls per morning per profile). No official source; inferred from community reports (liseller blog, LinkedIn developer rate-limit docs). Mitigated by fallback + retry-next-morning.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every piece is already in the project and verified in code
- Architecture / orchestration: HIGH — mirrors the existing campaign loop precisely
- Voyager endpoint shape: MEDIUM — community-standard endpoint, uncertain response schema fields → Wave 0 fixture-capture task absorbs this
- Sheet writeback extension: HIGH — trivial extension of `TRACKING_COLUMNS`/`FIELD_MAP`, precedent already set
- Electron external-browser plumbing: HIGH — verified in `electron/main.js`, zero new code
- UI patterns: HIGH — matches existing `/api/campaign/status` polling exactly
- Rate-limiting behavior: MEDIUM-LOW — no official data; mitigated by low call volume + DOM fallback
- Test framework recommendation: MEDIUM — `node --test` is stable but this project has never had a test suite; the plan-check phase should confirm the team wants a test framework at all, or whether manual verification per 11-VALIDATION.md is sufficient

**Research date:** 2026-04-21
**Valid until:** 2026-07-21 (90 days; the Voyager schema risk is the shortest-lived assumption and is absorbed by Wave 0 fixture capture. Everything else references in-repo code that is under our control.)
