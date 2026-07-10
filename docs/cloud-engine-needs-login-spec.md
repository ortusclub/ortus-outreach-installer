# Engine-side spec: flag SoO "Needs Login" when a cloud session dies

**Audience:** whoever owns / deploys the cloud campaign engine at
`https://scraper.ortusclub.com` (the service the desktop app dispatches cloud
campaigns to via `POST /api/campaign/start`). This is the one piece of
cloud↔local parity the desktop app **cannot** do itself.

**Status of the rest of SoO parity (already done in the app, for context):**
- In-Use credit flip + "CC App User" operator stamp — app does at dispatch.
- "Number of Connections (this week)" tally — app reconciles from `GET /api/campaign/:id/leads` (v2.151.0).
- Error/skip rows in the leads sheet — app reconciles (v2.150.0).
- **Needs Login — THIS doc.** Only the engine can detect it (see below).

---

## Why the app can't do this

Local campaigns flag an account **"Needs Login" = Y** on the SoO board the moment
its LinkedIn session dies. "Session dead" is a **browser-state fact**: after
launching/navigating a GoLogin profile, the page lands on a LinkedIn auth page
(`/login`, `/uas/login`, `/authwall`, `/checkpoint`). For a **cloud** campaign
that browser runs on the **engine**, not on the operator's Mac — so only the
engine can observe it.

We confirmed the engine's `GET /api/campaign/:id/leads` output carries **no**
session-death signal (probed across 12 campaigns): the only per-lead errors are
`Profile not found`, `Already connected`, `NOT_OPEN_PROFILE: …`, and
`Connect failed: Connect button not found …`. A dead session masquerades as those
ordinary per-lead failures, so any app-side heuristic would false-flag **healthy**
accounts for re-login — unacceptable for a shared board the LinkedIn team acts on.

**Reference — how the local app detects it** (`src/campaign.js`, `ensureProfileLoggedIn` health check):

```js
const cur = page.url();
if (cur && (cur.includes('/login') || cur.includes('/uas/login') || cur.includes('/checkpoint'))) {
  // cookies are dead → park this profile for the rest of the run + flag SoO
  return { healthy: false, issues, sessionExpired: true };
}
// (second check also treats '/authwall' as not-logged-in)
```

---

## What the engine ALREADY has (no new plumbing to receive)

Every cloud campaign is dispatched with these fields in `config` (sent by the
app's `POST /api/campaign/start-cloud`; visible today on `GET /api/campaign/:id`):

| field | example | use |
|---|---|---|
| `sheetsWebappUrl` | `https://script.google.com/macros/s/AKfycbwZu0…/exec` | POST target — the central Apps Script (handles BOTH leads writes and SoO writes) |
| `sooSheetId` | `1t49JaZppDZZNIUuOv2QQw7j1MCZC8vMMy1uZe_AkLwI` | which spreadsheet |
| `sooGid` | `992076199` | which tab ("LinkedIn Accounts") |
| `accountEmails` | `{ "689044f1…": "alex.sheeraz@ortus.solutions" }` | GoLogin **profileId → SoO Email** (already fuzzily resolved, skip-on-doubt, app-side) |

So for a dead account you already know its `profileId`; the SoO email is
`accountEmails[profileId]`.

---

## Option A (recommended): engine stamps SoO itself — self-contained, works when laptops are closed

### 1. Detect
At the same point you already launch/navigate a profile, if the landed URL
includes `/login`, `/uas/login`, `/authwall`, or `/checkpoint`, treat the
account's session as dead: park it for the rest of the run (as you likely
already do) **and** flag it once (see idempotency).

### 2. Write — one HTTP POST
`POST {config.sheetsWebappUrl}` with this JSON body:

```json
{
  "action": "setSoO",
  "sheetId": "<config.sooSheetId>",
  "gid": "<config.sooGid>",
  "email": "<accountEmails[profileId]>",
  "fields": { "Needs Login": "Y" },
  "guardAvailableFor": []
}
```

- The Apps Script (`handleSetSoO`) finds the row by the **"Email"** column
  (case-insensitive, trimmed) and sets the **"Needs Login"** cell to `Y`.
- `matched: false` in the response just means no SoO row for that email — harmless.
- No guard is needed for Needs Login (it's not a credit/write-once column).

### 3. The one gotcha: follow the 302
Apps Script answers a POST with a **302 redirect**; a naive client (Node `fetch`)
downgrades the follow to `GET` and loses the body. POST with manual redirect,
then GET the `Location`:

```js
// Reference: src/soo-writer.js postSetSoO()
const first = await fetch(webappUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
  redirect: 'manual',
  signal: AbortSignal.timeout(10_000),
});
let res = first;
if (first.status >= 300 && first.status < 400) {
  res = await fetch(first.headers.get('location'), { signal: AbortSignal.timeout(10_000) });
}
const data = await res.json(); // { success:true, matched:true, row, written:["Needs Login"] }
```

### 4. Idempotency + lifecycle
- Stamp **once per account per run** — keep a `Set<profileId>` for the run
  (mirrors local's `_sooNeedsLogin` guard) so a retry loop doesn't re-POST.
- **Never clear it.** Needs Login is cleared **manually** by the LinkedIn team
  after they re-log the account. Do not write `''`/`N` on recovery.
- Best-effort: a failed SoO POST must never affect the campaign; log and move on.

### 5. (Optional, secondary) also flag the LEADS sheet rows
Local also marks that account's rows in the campaign's own sheet as
`Needs Login = Y` (via the `updateRow` action you already use for write-back), so
operators can filter to the stalled leads. Nice-to-have, not required for SoO.

**Reference payload builder:** `src/soo-writer.js` → `buildNeedsLoginPayload({ email })`.
**Apps Script contract:** `google-apps-script.js` → `handleSetSoO()` (row-match by "Email", writes by header name).

---

## Option B (alternative): engine surfaces a signal, the app stamps

If you'd rather not have the engine write Google Sheets, expose the dead-session
fact and the **app will stamp SoO** (we'll wire this into the existing
`reconcileCloud()` path — small change on our side). Pick ONE:

- **Per-lead (weakest):** for leads that failed because the account's session was
  dead, set `error` to a **stable, machine-readable token** — e.g.
  `SESSION_EXPIRED` or `NEEDS_LOGIN` — distinct from generic connect failures.
- **Account-level (preferred):** add an accounts block to `GET /api/campaign/:id`,
  e.g.
  ```json
  "accountStates": { "689044f1…": { "needsLogin": true, "reason": "session_expired", "since": "2026-07-10T07:19:00Z" } }
  ```
  The app maps `profileId → accountEmails[profileId]` and POSTs the same `setSoO`
  above. This is cleaner than per-lead because "the session died" is an account
  fact, not a lead fact.

**Trade-off vs Option A:** Option B only stamps while an operator's app is open
and polling that campaign (eventually-consistent). Option A stamps immediately,
even with every laptop closed — which is the whole point of cloud. **Prefer A.**

---

## Acceptance test
1. Run a cloud connect campaign on a profile whose LinkedIn session is dead
   (or kill the cookies mid-run).
2. Expect the account's SoO "LinkedIn Accounts" row → **"Needs Login" = "Y"**,
   matched by the "Email" column, written exactly once.
3. Healthy accounts in the same run stay untouched (no false flags).
