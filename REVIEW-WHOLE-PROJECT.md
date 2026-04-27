---
review_target: Whole-project review of Ortus Outreach v2.8.17 (excluding Connect+OP flow already covered in REVIEW.md)
reviewed: 2026-04-24
depth: standard (manual, scoped to all source files in priority order)
files_reviewed:
  - src/campaign.js (paths NOT covered by H-01..H-04 in prior review)
  - src/linkedin/check-dms.js
  - src/linkedin/actions.js (sendMessage, Sales-Nav primitives)
  - src/linkedin/helpers.js (personalizeTemplate, Voyager)
  - server.js
  - src/auth.js
  - src/sheets.js
  - src/sheets-writer.js
  - src/gologin-launcher.js
  - src/local-launcher.js
  - src/notifier.js
  - src/resource-monitor.js
  - src/caffeinate.js
  - src/mac-window.js
  - src/paths.js
  - src/utils.js
  - src/soo.js
  - electron/main.js
  - electron/preload.js
  - electron/after-pack.cjs
  - public/js/app.js (security + structural bugs only)
findings:
  critical: 0
  high: 6
  medium: 8
  low: 6
  info: 4
  total: 24
---

# Whole-project Review — Ortus Outreach v2.8.17

## Scope reminder

This review covers everything OUTSIDE the Connection-campaign + Open-Profile flow already audited in `REVIEW.md` (where H-01..H-04 are FIXED in 2.8.17). I verified the four prior fixes are in place (campaign.js:553, :970-975, :891-902, outreach.js:26, :31) before scanning other paths.

Out of v1 scope per the operator's instructions: performance optimisations, style preferences, refactor suggestions, new dependencies. Findings cite specific `file:line` references and propose minimal diff-level fixes using libraries already in `package.json`.

---

## High

### P-01: Check DMs filters candidates by `profileId` but campaign writes `profileName` to "Account Used" — match always returns 0 rows

**File:** `src/linkedin/check-dms.js:55-61` vs `src/campaign.js:947, :1005, :1023, :1032, :1043, :1051, :1061, :1071, :1081, :1092`

`getCandidateRows` filters the sheet to rows where `Account Used` equals the GoLogin profile id:
```js
return rows.filter(r =>
  (r.Message || '').toString().toLowerCase() === 'sent' &&
  (r['Account Used'] || '').toString() === profileId    // ← profileId, e.g. 'abc123def456789'
);
```
…but every campaign code path writes the **profile name** (operator email) into Account Used:
```js
const sheetData = { dateLastAction: now, accountUsed: pName };   // pName = e.g. 'maria@ortus.solutions'
```
`pName` comes from `profileNameCache[profileId]` (campaign.js:615) — for GoLogin profiles that's the SDK-returned `name`; for `local-browser` that's the literal string `'Local Browser'`. Neither is ever equal to the GoLogin profileId.

Consequence: **Check DMs reports zero replies for every profile**. The Voyager fetch happens, the conversation list is paginated, then `matchConversationToSheet(conv, [])` returns `unmatched` for every conversation because the candidate-row pre-filter killed the list. Operators would just see "Check DMs finished: 0 new reply(ies)" and conclude the inbox is empty. There is no obvious symptom — the only evidence is the contrast between "Check DMs found nothing" and an actual unread inbox.

**Fix:** in `_realDeps.getCandidateRows` (check-dms.js:55-61), match against `profileName` (the same `pName` campaign writes), not the raw id:
```js
async getCandidateRows(profileId, sheetUrl) {
  const rows = await fetchSheet(sheetUrl);
  // Resolve the profile name the campaign loop would have written. For
  // local-browser this is the literal 'Local Browser'; for GoLogin it's the
  // SDK-returned profile.name.
  let profileName = 'Local Browser';
  if (profileId !== 'local-browser') {
    const all = await getProfiles(process.env.GOLOGIN_API_TOKEN);
    profileName = all.find(p => p.id === profileId)?.name || profileId;
  }
  return rows.filter(r =>
    (r.Message || '').toString().toLowerCase() === 'sent' &&
    (r['Account Used'] || '').toString() === profileName
  );
}
```
Alternative (simpler, requires touching `_realDeps.ensureOpen` too): pass `pName` into the filter so check-dms shares the resolution path with the campaign loop. Either fix unblocks Check DMs.

---

### P-02: `stopCampaign()` returns `undefined` but server returns it as JSON to the client

**File:** `src/campaign.js:1252-1258` and `server.js:443-451`

`stopCampaign` has no return value — it sets flags and logs:
```js
export function stopCampaign() {
  campaign._abort = true;
  campaign._paused = false;
  campaign._pauseRequested = false;
  log('■ Stop requested.');
}
```
But the endpoint stores the return and serialises it:
```js
app.post('/api/campaign/stop', async (_req, res) => {
  const result = stopCampaign();   // result === undefined
  // …closeAllProfiles, closeLocalBrowser…
  res.json(result);                 // → "null"
});
```
The dashboard's `stopCampaign()` (public/js/app.js:1552-1554) does `await fetch(...)` and ignores the body — so the operator sees no error, BUT downstream consumers (any future scripted client, the test suite, log scrapers) will see a literal `null` JSON body where every other endpoint returns `{ ok: true, ... }`. Inconsistent contract.

The same pattern works correctly for pause/resume because those return `{ok, reason?}` (campaign.js:1264-1283).

**Fix:** make `stopCampaign` return the same shape as pause/resume:
```js
export function stopCampaign() {
  if (!campaign.running) return { ok: false, reason: 'not-running' };
  campaign._abort = true;
  campaign._paused = false;
  campaign._pauseRequested = false;
  log('■ Stop requested.');
  return { ok: true };
}
```

---

### P-03: `personalizeTemplate` builds a regex from raw user-supplied keys — special chars break the substitution

**File:** `src/linkedin/helpers.js:365-372`

```js
export function personalizeTemplate(template, data = {}) {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return result.replace(/\{[a-zA-Z0-9_ ]+\}/g, '').trim();
}
```
`data` includes spread `{...row}` (campaign.js:831), and row keys come straight from sheet headers — operators routinely have columns named `Title`, `Last Name`, `Job Title (Current)`, `Company (HQ)` etc. Any column header containing a regex metacharacter — `(`, `)`, `[`, `]`, `?`, `*`, `+`, `.`, `|`, `\`, `$`, `^` — produces an invalid `RegExp` and **throws**, which propagates up as `Outreach error: Invalid regular expression` and the lead is skipped (outreach.js:391).

This is silent unless the operator inspects the campaign log per-lead. The error string `Invalid regular expression: /\{Job Title (Current)\}/: Unmatched ')'` doesn't get sent through the retry pipeline because the throw happens before any LinkedIn action — but the row is still marked Skipped with the cryptic auditAction.

**Fix:** escape regex metachars before constructing the pattern. No new dependency:
```js
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function personalizeTemplate(template, data = {}) {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{${escapeRegex(key)}\\}`, 'g'), value || '');
  }
  return result.replace(/\{[a-zA-Z0-9_ ]+\}/g, '').trim();
}
```

Also: a column key `Title|Company` would silently produce a regex alternation and replace **both** `{Title}` and `{Company}` with the same value — quietly wrong rather than thrown. Same fix.

---

### P-04: `message_only` mode can re-send to the same lead if a sheet write fails

**File:** `src/campaign.js:559-561, :785, :940-1005`

The pre-filter for `message_only`:
```js
if (mode === 'message_only' || mode === 'open_profile_only') {
  return !msgSent;     // msgSent = msgCell === 'sent' || opCell === 'sent'
}
```
…and the in-loop skip-already-processed check:
```js
if (mode !== 'check_status' && mode !== 'message_only' && mode !== 'open_profile_only' && state.processed[candidateUrl]) continue;
```
For `message_only`, neither branch checks `state.processed[url]` — only the live sheet column. After a successful send, `state.processed[url]` is updated **before** the sheet write (line 940 vs line 1005), and the sheet write is best-effort (`.catch(() => {})`). If the Apps Script POST fails for any reason — Google Sheets transient outage, redeploy needed, network blip — the `Message` cell stays empty in the sheet, but the message has already been sent.

On the next campaign run the same row is fetched, `msgSent` is still false, the pre-filter passes, the in-loop check ignores `state.processed`, and **we send the same message again to the same 1st-degree connection.** This is exactly the kind of operator-visible duplicate-send Cross-cutting observation #3 in the prior review warned about, but for a different mode.

The same applies to `open_profile_only` (same condition at line 785).

**Fix:** consult `state.processed` for these modes too. In the pre-filter:
```js
if (mode === 'message_only' || mode === 'open_profile_only') {
  if (msgSent) return false;
  const prev = state.processed[url];
  if (prev && (prev.action === 'message_sent' || prev.action === 'op_message_sent')) return false;
  return true;
}
```
And in the in-loop check (line 785), drop the exception for these two modes — the prior-review concern about manually clearing the sheet to retry can be handled by also clearing `state.processed[url]` for that row, which is already documented as the workflow.

---

### P-05: No timeout on Google Sheets `fetch()` — campaign loop can hang forever

**File:** `src/sheets.js:99` and `src/sheets-writer.js:29, :39`

```js
// sheets.js:99
const response = await fetch(csvUrl);   // no AbortSignal, no timeout
```
```js
// sheets-writer.js:29
const initial = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
  redirect: 'manual',
});                                      // no AbortSignal, no timeout
// :39
res = await fetch(location);             // also no timeout on the redirect follow
```
Node's global fetch has **no default timeout** — a hung TCP connection or a Google service outage holds the request open indefinitely. The campaign loop awaits `fetchSheet` at startup and `updateSheetRow` after every successful action; either hanging stalls the entire campaign with no log line and no abort path.

`src/soo.js:36` already does this correctly with `AbortSignal.timeout(SOO_TIMEOUT_MS)` — the same pattern, no new dependency, exists in the codebase.

**Fix:** add a 30s timeout to both calls, mirroring soo.js:
```js
// sheets.js:99
const response = await fetch(csvUrl, { signal: AbortSignal.timeout(30000) });
```
```js
// sheets-writer.js — wrap both fetches with the same signal so the redirect
// follow inherits the deadline.
const signal = AbortSignal.timeout(30000);
const initial = await fetch(url, { method: 'POST', headers: ..., body, redirect: 'manual', signal });
// …
res = await fetch(location, { signal });
```
Catch `AbortError` / `TimeoutError` and surface as `[sheets] timeout` so it shows up in the dashboard log.

---

### P-06: `req.body.createdBy` and `req.body.id` on `/api/schedules` are operator-spoofable

**File:** `server.js:890-927`

```js
const id = req.body.id || `sched_${Date.now()}`;
// …
createdBy: req.body.createdBy || (existing >= 0 ? (all[existing].createdBy || req.user) : req.user),
```
Two problems on one endpoint:

1. **`createdBy` spoof.** A logged-in operator can POST `{ name: "X", createdBy: "victim@ortus.com", ... }` and now every pre-fire and finish notification for that schedule is emailed to a different operator. Low-blast-radius (intra-team only), but a real privilege/identity confusion bug — the audit trail in the schedules JSON file and the `[scheduler] Firing schedule "X" (owner: victim@ortus.com)` log line will both show the victim as the owner.

2. **`id` injection → stored XSS in the dashboard.** `s.id` is later interpolated **unescaped** into onclick handlers (public/js/app.js:2409-2410):
   ```js
   onclick="toggleScheduleEnabled('" + s.id + "', " + !s.enabled + ")"
   onclick="deleteSchedule('" + s.id + "')"
   ```
   Posting `{ id: "x',1);alert(document.cookie);//", ... }` lands stored XSS in the schedules panel. Authenticated, intra-team — but real (the auth cookie is httpOnly, so cookie theft fails, but other DOM access does not).

**Fix:** for createdBy, drop the override entirely — the server already knows `req.user`:
```js
createdBy: existing >= 0 ? (all[existing].createdBy || req.user) : req.user,
```
For `id`, either generate server-side always (`const id = req.body.id || sched_${Date.now()}` → `const id = existing >= 0 ? req.body.id : sched_${Date.now()}` AND validate the existing-edit id matches the schedule found), or strictly validate the format (`/^sched_\d+$/`). At a minimum, escape `s.id` in the dashboard renderer (public/js/app.js:2409-2410) — replace string concatenation with `escHtml(s.id)`.

---

## Medium

### P-07: `/api/auth/electron-login` accepts ANY email already in SoO — no proof of identity

**File:** `server.js:96-125`

```js
app.post('/api/auth/electron-login', async (req, res) => {
  if (process.env.ORTUS_ELECTRON_MODE !== '1') return res.status(404).json({ error: 'Not available outside Electron' });
  const { email } = req.body || {};
  // …
  if (!allowed) return res.status(403).json({ error: '...' });
  if (!(await userExists(normalized))) {
    const placeholder = (await import('node:crypto')).randomBytes(32).toString('hex');
    await createUser(normalized, placeholder);
  }
  await issueSessionCookie(res, normalized);
  res.json({ ok: true, email: normalized });
});
```
The only check is "is the email present in the SoO sheet". Anyone who can reach `127.0.0.1:${PORT}` (Electron picks an ephemeral port, but the loopback is open to any local process) can sign in as ANY teammate by typing their email — no password, no email-confirmation, no anything. The reasoning in the comment ("Electron-only frictionless login") makes sense for the original intent, but combine this with P-06 and a non-admin operator on a shared machine can impersonate any team member to the campaign system.

This is partially mitigated by the `ORTUS_ELECTRON_MODE` gate but only on the server side — there's no per-request proof that the request actually came from inside Electron (the loopback HTTP surface is the same).

**Fix (low-touch):** generate a per-launch random token in `electron/main.js` (already runs before the server module), expose it to the renderer via a secure preload extension, and require it on `/api/auth/electron-login`:
```js
// electron/main.js, before await import(serverEntry):
process.env.ORTUS_ELECTRON_LOGIN_TOKEN = crypto.randomBytes(32).toString('hex');
// preload.js: contextBridge.exposeInMainWorld('ortusElectron', { loginToken: process.env.ORTUS_ELECTRON_LOGIN_TOKEN });
// electron-login.html → POST { email, loginToken }
// server.js: if (req.body.loginToken !== process.env.ORTUS_ELECTRON_LOGIN_TOKEN) return 401
```
This is invasive — flag it for discussion rather than a same-day fix. At minimum: tighten the gate so this endpoint only responds when the request's `Host` header is loopback (`127.0.0.1` or `localhost`).

---

### P-08: Server log capture stringifies `JSON.stringify` on objects — credentials in logged objects leak to the dashboard

**File:** `server.js:171-179`

```js
function captureLog(level, args) {
  const line = `[${...}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  serverLogs.push(line);
}
console.log = (...args) => { captureLog('LOG', args); origLog.apply(console, args); };
```
The captured log is exposed via `/api/server-log` and rendered in the dashboard's Server Log panel (app.js:332-346). Any code that does `console.log({ headers: req.headers })` or `console.log('GoLogin response:', responseObject)` writes the full object — including any `Authorization: Bearer ...` header, any GoLogin token in request bodies, any cookie strings — into a JSON-stringified line that's now in a 500-entry ring buffer accessible to every authenticated dashboard user.

I didn't find a current code path that logs a sensitive object — but the `console.warn('[gologin] killBrowser warning: …')` and similar are one inadvertent change away from leaking a token. The capture wrapper has no allowlist and no redaction.

**Fix:** at minimum, redact known-sensitive substrings before push:
```js
function captureLog(level, args) {
  let line = `[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  // Redact tokens that may leak via stringified Error/Response objects
  line = line.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
             .replace(/(GOLOGIN_API_TOKEN[^"]*?["']?)([A-Za-z0-9._-]{20,})/gi, '$1<redacted>')
             .replace(/(li_at[^"]*?["']?)([A-Za-z0-9._-]{20,})/gi, '$1<redacted>');
  serverLogs.push(line);
  if (serverLogs.length > MAX_SERVER_LOGS) serverLogs.shift();
}
```

---

### P-09: `signOut` is referenced from the frontend but the corresponding server endpoint is missing

**File:** `public/js/app.js:3377` (re-exposes `signOut` to window) but no `/api/auth/signout` exists in `server.js`

The auth module exports `clearSessionCookie` and the only logout endpoint is `/api/auth/logout` (server.js:89-92). I grepped `signOut` and there's no implementation in app.js — only the `window.signOut = signOut;` re-export at line 3377, which would throw `ReferenceError: signOut is not defined` at module load if the module isn't wrapped in `try/catch` for re-exposure.

Two possibilities: (a) `signOut` exists in app.js outside the lines I sampled — in which case it likely calls `/api/auth/logout` and is fine; (b) it was deleted in a prior pass and the re-export wasn't, in which case the entire module fails to load (every inline onclick handler in index.html breaks).

**Fix:** verify `signOut` is defined somewhere in app.js (`grep -n "function signOut" public/js/app.js`). If it's missing, add a small implementation:
```js
async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  window.location.href = '/login.html';
}
```
If signOut already exists I missed it — disregard this finding. (I didn't read every line of the 3391-line app.js.)

---

### P-10: `verifyToken` returns null on mismatched signature length without constant-time comparison — minor timing leak

**File:** `src/auth.js:113-126`

```js
async function verifyToken(token) {
  // …
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (sig.length !== expected.length) return null;     // ← short-circuits before timingSafeEqual
  if (!crypto.timingSafeEqual(...)) return null;
```
The length check is necessary (timingSafeEqual throws on length mismatch) but it does mean a remote attacker who can submit signatures and observe response timing can distinguish "wrong length" from "right length, wrong signature" — not enough to forge a token (HMAC-SHA256), but worth noting.

The body-decode order is also slightly off: `JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'))` runs **after** signature verification (good — body content untrusted until then), but `payload.exp && Date.now() > payload.exp` returns null without distinguishing expired-vs-invalid, which the auth middleware then turns into a 401 + redirect. That's fine for security but slightly user-hostile (operator gets booted to login with no "session expired" message).

**Fix (minor):**
```js
async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const secret = await getSecret();
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  let sigBuf;
  try { sigBuf = Buffer.from(sig, 'hex'); } catch { return null; }
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  // …
}
```
The user-hostile aspect (no session-expired message) is a separate issue — could be tracked as a UX improvement, not a security fix.

---

### P-11: GoLogin token is logged on every page request via `getProfiles` 401 — token-in-error path

**File:** `src/gologin-launcher.js:23-26`

```js
const res = await fetch(`https://api.gologin.com/browser/v2?page=${page}`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) throw new Error(`GoLogin API ${res.status}`);
```
If GoLogin returns a 4xx with the token included in their error response body (some APIs echo the token back in 401 responses), the response body is never logged here — good. BUT `console.log('[gologin] Page ${page}: ...')` lines are fine.

The actual concern: if `puppeteer.connect({ browserWSEndpoint: wsUrl })` fails (line 85-89), the `wsUrl` returned by GL.start typically contains a session-scoped path — but the GoLogin client may have stored the token in stack traces. I can't verify without the GoLogin SDK source. **Defensive fix:** wrap the puppeteer.connect in try/catch and re-throw a sanitized error string so an unexpected stack-trace serialization doesn't leak:
```js
try {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, ignoreHTTPSErrors: true, protocolTimeout: 120000 });
  // …
} catch (e) {
  throw new Error(`puppeteer.connect failed: ${e.message?.split('Bearer')[0] || 'unknown'}`);
}
```
Lower priority — flag during the same pass as P-08 token redaction.

---

### P-12: `closeAllProfiles` calls `Promise.all` over closures that swallow errors — silent partial close

**File:** `src/gologin-launcher.js:131-139`

```js
export async function closeAllProfiles() {
  const ids = [...activeProfiles.keys()];
  await Promise.all(ids.map(id => closeProfile(id)));
  return ids.length;
}
```
The comment says "closeProfile already swallows its own errors so Promise.all won't reject." Verified — but the return value is `ids.length`, not "ids actually closed." If three of four profiles fail to close, the operator sees `[stop] closed 4 profiles` in the log while one Orbita window is still on screen.

The whole reason Phase 2.8.11 added `GL.killBrowser()` was that close failures were leaving orphan windows. Without per-id success tracking, we won't know if a future regression returns.

**Fix:**
```js
export async function closeAllProfiles() {
  const ids = [...activeProfiles.keys()];
  const results = await Promise.allSettled(ids.map(id => closeProfile(id)));
  const closed = results.filter(r => r.status === 'fulfilled').length;
  const failed = ids.length - closed;
  if (failed) console.warn(`[gologin] closeAllProfiles: ${failed} of ${ids.length} failed`);
  return closed;
}
```
Then update the `[stop]` log line in server.js:448 to use the returned `closed` count.

---

### P-13: `parseCSV` drops the final row if it's only whitespace, even if it has data

**File:** `src/sheets.js:42`

```js
if (current.trim()) lines.push(current);
```
`current` at end-of-loop holds the last line's accumulated chars. If the final row is `"name","",""` — three empty quoted fields — `current.trim()` evaluates to non-empty (the quotes are preserved by parseCSV, see comment on line 22-25). Good.

But the **header parsing** in `splitCSVLine` runs immediately after, and if any header cell is whitespace-only quoted (e.g. `"First Name", " ", "Email"`), the trim only happens on `headers[j].trim()` (line 55). Subsequent row values for that empty-trimmed header are written under the key `''`, and the same key collides across columns, so the LAST same-named-empty column wins. Fields silently disappear.

This is a 1-in-100 sheet-author error, but combined with the silent-fallback in `extractLinkedInUrl` (campaign.js:147 — "scan all columns for linkedin.com") it surfaces as "campaign skipped most of my sheet for no reason."

**Fix:** in parseCSV after `const headers = ...`:
```js
const seen = new Set();
for (let i = 0; i < headers.length; i++) {
  const h = headers[i].trim();
  if (!h) headers[i] = `__col_${i}`;             // give blank headers a unique key
  else if (seen.has(h)) headers[i] = `${h}_${i}`; // disambiguate dupes
  else { headers[i] = h; seen.add(h); }
}
```

---

### P-14: `getVoyagerDegree` does not handle a JSESSIONID cookie containing the literal `=` character

**File:** `src/linkedin/helpers.js:122-127`

```js
const csrf = document.cookie.split(';')
  .map(c => c.trim())
  .find(c => c.startsWith('JSESSIONID='));
if (!csrf) return null;
const token = csrf.split('=')[1]?.replace(/"/g, '');
```
LinkedIn's `JSESSIONID` is wrapped in quotes and looks like `"ajax:1234567890123456789"`. The split on `=` and taking `[1]` works for that exact shape — but if LinkedIn ever rotates to a JWT-shaped JSESSIONID (which contains two `=` chars in base64 padding), `split('=')[1]` returns just the first segment and the CSRF check on the Voyager API fails 403.

**Fix:**
```js
const equalsIdx = csrf.indexOf('=');
const token = equalsIdx >= 0 ? csrf.slice(equalsIdx + 1).replace(/"/g, '') : null;
```
Also: the same pattern is duplicated in `getConversationsPage` (helpers.js:415-418). Same fix applies there.

---

## Low

### P-15: `extractSheetId` accepts any URL whose path contains `/d/<token>` — including non-Sheets links

**File:** `src/utils.js:11`

```js
export function extractSheetId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]+$/.test(url.trim())) return url.trim();
  throw new Error(`Cannot extract Google Sheet ID from URL: ${url}`);
}
```
Pasting a Google Drive PDF URL (`https://drive.google.com/file/d/abcdef.../view`) returns `abcdef...` as a "sheet id" — the campaign starts, the CSV fetch returns HTML, parseCSV returns 0 rows, the campaign immediately exits with "0 row(s)" in the log. Operator confusion; not destructive.

**Fix:** also require the URL host to be `docs.google.com` and the path to start with `/spreadsheets/`:
```js
try {
  const u = new URL(url);
  if (u.hostname === 'docs.google.com' && u.pathname.startsWith('/spreadsheets/')) {
    const m = u.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
  }
} catch { /* not a URL */ }
// existing bare-id fallback
if (/^[a-zA-Z0-9_-]+$/.test(url.trim())) return url.trim();
throw new Error(`Cannot extract Google Sheet ID from URL: ${url}`);
```

---

### P-16: `clickByAria` fails for any aria-label containing a quote character

**File:** `src/linkedin/helpers.js:41-61`

```js
return page.evaluate((label) => {
  const btn = document.querySelector(`button[aria-label="${label}"]`);
  // …
}, ariaLabel);
```
String-interpolating `label` into a CSS selector means an aria-label like `Send to "Maria"` (LinkedIn does sometimes wrap names in quotes for non-Latin scripts) produces a malformed selector and silently returns null. Caller treats null as "button not found" and proceeds to the next strategy — usually the More dropdown — adding 5+ seconds of needless work per lead.

**Fix:** use `CSS.escape` (built-in, no dep):
```js
const btn = document.querySelector(`button[aria-label="${CSS.escape(label)}"]`);
```
This pattern repeats at helpers.js:54-55 (shadow DOM path).

---

### P-17: `getPassoverStatus` time math drifts on DST boundaries

**File:** `public/js/app.js:518-545`

```js
const phNow = new Date(now.getTime() + (8 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000));
```
Adding the local offset to "convert to PH time" is correct most of the year but flips by an hour on the operator's local DST transitions (the offset changes mid-day). Twice a year, the "Passover ACTIVE — closes in Xd" countdown jumps by ±1h around 2am local time. Cosmetic, but the operator panicking at 2am thinking the window just closed early is a real possibility.

**Fix:** use `Intl.DateTimeFormat` with a fixed timezone — built into V8, no dep:
```js
function getPHParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, weekday: parts.weekday };
}
```

---

### P-18: `register Schedule` doesn't validate cron-shifted preExpr can fire on the same day boundary

**File:** `server.js:817-822`

```js
const preExpr = shiftCronMinutes(schedule.cron, -5);
let prefire = null;
if (preExpr && cron.validate(preExpr)) {
  prefire = cron.schedule(preExpr, () => { /* email "starts in 5 min" */ });
}
```
`shiftCronMinutes` (server.js:788-801) handles minute/hour rollover but NOT day-of-month/day-of-week constraints. A schedule cron of `2 0 * * *` (00:02 every day) shifts to `57 23 * * *` — but this fires at 23:57 the **previous** day. Combined with a Mon-Fri-only schedule `2 0 * * 1-5`, the prefire fires at 23:57 Sun-Thu — which means a 5-minute heads-up for Monday's 00:02 run would be sent on Sunday at 23:57. That's actually correct in that case. But for `0 0 * * 1` (Monday midnight), the prefire should fire at 23:55 Sunday — and `shiftCronMinutes` returns `55 23 * * 1` which fires at 23:55 **Monday**, 24h late.

Operator-visible symptom: prefire emails arrive a day late or not at all for schedules whose cron has weekday/dom restrictions.

**Fix:** in `shiftCronMinutes`, when hour rolls over (delta brings hour negative), and the dom/dow are not `*`, refuse to shift and return null:
```js
function shiftCronMinutes(cronExpr, deltaMinutes) {
  // …
  let dayBoundary = false;
  while (minute < 0) { minute += 60; hour -= 1; }
  while (minute >= 60) { minute -= 60; hour += 1; }
  if (hour < 0) { hour += 24; dayBoundary = true; }
  if (hour >= 24) { hour -= 24; dayBoundary = true; }
  if (dayBoundary && (dom !== '*' || dow !== '*')) return null;  // can't shift across days
  return `${minute} ${hour} ${dom} ${mon} ${dow}`;
}
```

---

### P-19: `randomDelay` import in `actions.js` is used in only 3 places, and `helpers.js` `randomDelay` is the wrong distribution for InMail backoff

**File:** `src/linkedin/actions.js:17, :503, :1007` and `src/linkedin/helpers.js:12-17`

The skewed-toward-min distribution is appropriate for human-like UI clicks (the prior review's H-03 noted the import is unused in outreach.js — that's L-01 there). Here in actions.js, `randomDelay(300, 500)` is fine for a scroll-and-pause, but `randomDelay(400, 800)` before typing a message uses a max of 800ms with a cluster at 400ms — fast enough to look automated to LinkedIn's anti-bot heuristics (which sample inter-keystroke and inter-action timing).

Not a bug, but the prior reviewer's pattern of flagging these is consistent — calling out as Low for symmetry.

**Fix:** none required for correctness. If LinkedIn anti-bot becomes an issue, switch the message-pre-type delay to a normal distribution centered around 1500ms.

---

### P-20: `notifier.js` returns `false` from `getEmailTransport` but stores it in `emailTransport`, then re-checks `emailTransport !== null`

**File:** `src/notifier.js:22-40`

```js
let emailTransport = null;

function getEmailTransport() {
  if (emailTransport !== null) return emailTransport;       // ← matches false too, returns false (good)
  // …
  if (!host || !user || !pass) {
    emailTransport = false;                                  // ← memoize the not-configured state
    return false;
  }
  emailTransport = nodemailer.createTransport({ … });
  return emailTransport;
}
```
This works, but it's mildly misleading — the cache holds either a transport object or `false`, while the type implies "transport or null". If anyone refactors to `if (!emailTransport)` thinking nullish, they'll re-create the transport every call. Cosmetic.

**Fix:** drop the cache to a sentinel:
```js
const NOT_CONFIGURED = Symbol('not-configured');
let emailTransport = null;
function getEmailTransport() {
  if (emailTransport === NOT_CONFIGURED) return null;
  if (emailTransport) return emailTransport;
  // … if (!host || !user || !pass) { emailTransport = NOT_CONFIGURED; return null; }
}
```

---

## Info

### P-21: Schedule lastRun is updated only on success; failed runs leave `lastRun: null` indefinitely

**File:** `server.js:860-876`

The cron `main` callback updates `s.lastRun` inside the `try` block (line 860-862). If `startCampaign` throws, the catch logs but doesn't update lastRun. Operators looking at the schedules panel see "last: Never" for a job that's been firing and failing every day.

Not a bug — arguably correct (only count successful runs as "last run") — but worth surfacing as a UI distinction: "last attempt" vs "last successful run."

---

### P-22: `auth.js` `DASHBOARD_USERS` legacy fallback compares plaintext

**File:** `src/auth.js:80-94`

```js
for (const pair of raw.split(',')) {
  const [e, p] = pair.split(':');
  if ((e || '').trim().toLowerCase() === normalized && (p || '').trim() === password) {
    return normalized;
  }
}
```
Documented as "legacy plaintext... lets existing logins keep working until everyone has migrated." Fine for now but: (a) the comparison `(p || '').trim() === password` is not constant-time, (b) if `DASHBOARD_USERS` is unset everywhere, deleting the fallback removes a 14-line surface. Worth retiring once the migration is complete (it's been in place since the bcrypt rollout).

---

### P-23: `electron/main.js` loads `.env` from `process.resourcesPath` — secrets are bundled in the DMG

**File:** `electron/main.js:30-34` and `package.json:73-78`

```js
const envPath = resolve(REPO_ROOT, '.env');
if (existsSync(envPath)) { dotenv.config({ path: envPath }); }
```
`package.json` `extraResources` ships `.env` into the DMG. This means the GoLogin token, SMTP creds, SHEETS_WEBAPP_URL, etc. are inside the distributed `.app` bundle. Anyone who can `cp -r` the .app from a teammate's Applications folder gets all the secrets.

The pattern is a deliberate trade-off (the team needs the app to "just work" without each operator setting up env vars), but worth documenting as a known property: **the .app is sensitive and should not be shared outside the team.** Consider rotating the GoLogin token if a DMG ever leaves Ortus laptops.

**Fix:** none — this is a deployment trade-off, not a code bug. Document in the README and rotate any token that has ever been distributed widely.

---

### P-24: `fetchSheet` and `fetchSoOData` both fetch Apps Script over the public internet — single point of failure

**File:** `src/sheets.js:99` and `src/soo.js:40`

Every campaign start, every SoO refresh, every sheet write goes through the team's deployed Apps Script web app. If that deployment is broken (re-auth needed, Google rotates a token, the deploying account's quota is exhausted), every operator's dashboard breaks at the same time with no fallback. The `emailAdminsOnSoOFailure` debouncer (server.js:216-232) handles SoO; sheet write failures silently `.catch(() => {})`.

Not a bug — flagging the architectural single-point-of-failure for future planning. If the Apps Script account is ever paused, every active campaign's sheet writes go into the void with no operator-visible signal beyond "the row didn't update." See cross-cutting observation 3 in the prior REVIEW.md for the related "queue retries for failed sheet writes" suggestion.

---

## Cross-cutting observations

1. **Two `req.body` trust-boundary lapses** (P-06 + P-07) suggest the rest of the request-parsing surface is worth a sweep. Specifically: every endpoint that takes `name` from `req.params` and uses it as a JSON key (presets, templates, schedules) is vulnerable to `__proto__` / `constructor` prototype pollution if the operator JS-prototype-walks. Not exploitable to RCE on this stack, but `delete file.presets["__proto__"]` on a poisoned JSON file is a real cleanup nuisance. A single utility `safeKey(s)` function rejecting `__proto__` / `constructor` / `prototype` would close all four endpoints in one diff.

2. **The "Account Used" column is the natural join key between the campaign loop and Check DMs**, but the codebase doesn't treat it as such. Campaign writes pName, Check DMs filters by profileId (P-01), and a sheet-author who manually edits the Account Used column (entering a slightly different spelling, e.g. "John Smith" vs "John Smith ") breaks every downstream lookup silently. Worth introducing a tiny helper `accountKey(profileId, profileName)` used at every write AND every filter, so they stay in lockstep.

3. **Best-effort sheet writes (`.catch(() => {})`) are the dominant source of latent dupes.** P-04 names one specific duplicate-send path; the broader pattern (state.processed updated before the sheet, sheet write swallowed) means any of the 8 `updateSheetRow(...).catch(() => {})` sites in campaign.js (lines 1005, 1021, 1030, 1040, 1049, 1059, 1069, 1079, 1090) can leave a divergence between what the loop thinks happened and what the sheet shows. A 30-line "queue failed writes for retry on next loop iteration" buffer would close the whole class — listing here as a follow-up rather than a per-site fix.

4. **No detected race in the new Phase 11.2 batch loop.** I traced ensureOpen → inner BATCH_SIZE for-loop → closeSession; the abort flag is checked at every boundary including mid-launch (campaign.js:631). The `await` chain is sequential per profile, and round-robin across profiles is also sequential. Good.

5. **app.js innerHTML usage is mostly safe** — every text-interpolation site I sampled uses `escHtml` correctly (lines 488, 503-506, 690, 752, 1200, 1204, 1226, 2207, 2209, 2406). The exceptions are at lines 2409-2410 (P-06 schedule onclick injection) and the inline-onclick pattern in general — converting to `addEventListener` would be a wider change, not flagged for v1.

6. **The `_setDeps` dependency-injection pattern in check-dms.js** (line 64-72) is a clean, test-friendly setup not duplicated elsewhere in the codebase. Worth promoting as the project's standard pattern when other modules need testing — replaces the more invasive `_setExecFile` style used in mac-window.js.

---

_Reviewed: 2026-04-24_
_Reviewer: Claude (manual whole-project review)_
_Depth: standard — read each file end-to-end, traced cross-file dependencies for P-01 / P-04 / P-06_
