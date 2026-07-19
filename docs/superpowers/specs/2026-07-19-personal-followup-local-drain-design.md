# Personal-Primary Follow-up: Local Drain (Option 1) — Design

**Status:** approved for planning (2026-07-19)
**Supersedes (for personal primaries):** the VM cookie-replay follow-up in
`2026-07-17-primary-vm-followup-design.md`. That path is retired for personal
primaries and kept dormant for GoLogin primaries only.

## Why

Sending a CC+IC follow-up **as a personal LinkedIn account** from the cloud VM
is fundamentally unsafe: the account is used from a Google datacenter IP while
its real owner is simultaneously logged in on their own machine — LinkedIn's
strongest security-logout trigger (concurrent session + impossible-travel),
compounded by datacenter-ASN reputation and an unavoidable Chromium-on-Linux vs
Chrome-on-macOS fingerprint mismatch. Reproduced live: the replayed session
authenticated once, then LinkedIn invalidated it within ~15 min. Researched: no
proxy/fingerprint workaround makes it reliable, and each attempt risks getting
the personal account restricted.

The only safe context for a personal-account follow-up is **the owner's own
machine** — same IP, device, and session. The app already sends personal
follow-ups this way for fully-local campaigns. Option 1 makes a cloud campaign's
follow-up leg **behave exactly like a local campaign's**: hand the follow-up
back to the existing local runner.

## Constraints (global)

- **Personal primary = the primary runs their own campaign.** The app instance
  that launched the cloud campaign (owner = that operator's email) is the one
  that drains its follow-ups. No cross-machine routing.
- **GoLogin primary → unchanged.** Follow-up runs on the VM via that GoLogin
  profile (engine `handleFollowUp` GoLogin branch, already correct).
- **Mirror local exactly.** Reuse the existing local follow-up primitives
  (`buildFollowUpTask`, `enqueuePrimaryTask`, the `[primary-runner]`). No new
  send logic, no new sheet writes. Local follow-ups do NOT stamp the Google
  Sheet today (`primary-task-runner.js` `_processOne` only sends + logs in-app);
  cloud follow-ups mirror that — send + in-app log, no sheet stamp.
- **`sender = 'local-browser'`** is the marker for a personal-primary follow-up
  (the engine already stamps this on the `follow_up` task payload).
- Nothing pushed to GitHub without explicit approval; engine deploys via Cloud
  Build to GKE.

## Architecture

```
CLOUD CAMPAIGN (personal primary)
  VM (engine): connect → accept → intro       [unchanged]
  VM (engine): on fresh intro, create follow_up task (sender=local-browser, dueAt=+delay)   [unchanged]
  VM (engine): scheduler SKIPS personal follow_up tasks — never sends them       [CHANGE 1]
                └ task stays status='pending', due, waiting for the app

  APP (owner's machine, when open):
    poller (60s): GET the owner's due personal follow-ups from the engine        [NEW]
      → for each: buildFollowUpTask(...) + enqueuePrimaryTask() into primary-tasks.json   [reuse]
      → POST ack(taskIds) → engine marks them 'delegated' (won't re-offer)        [CHANGE 2 + NEW]
    primary-runner (existing 60s tick): drains local-browser follow-ups →
      sendInThread from the owner's OWN browser → in-app log                       [unchanged]
    nudge: if any pulled follow-up was long overdue (app was closed), surface a
      count so the operator knows late follow-ups are going out now               [NEW, small]
```

The engine keeps the `follow_up` task as the single source of record (its
payload already carries thread, body, lead, primary, delay). The app is a puller
that converts each into the local queue's shape; the local runner does the rest.

## Components & interfaces

### Engine (`ortus-salesnav-scraper-cloud`)

**CHANGE 1 — `campaign-store.js` `claimNextDueTask()`**: add to the inner
`WHERE` so the VM scheduler never claims a personal follow-up:
```sql
WHERE status='pending' AND due_at <= now()
  AND NOT (type='follow_up' AND payload->>'sender' = 'local-browser')
```
GoLogin follow-ups (`sender` = a profileId) and all other task types are
unaffected.

**NEW — `campaign-store.js` accessors:**
- `getPendingLocalFollowups(owner)` → rows where `type='follow_up'` AND
  `payload->>'sender'='local-browser'` AND `status='pending'` AND `due_at<=now()`
  AND the task's campaign has `owner=$1`. Join `campaign_tasks` → `campaigns` on
  `campaign_id`. Return `{taskId, campaignId, sheetUrl, payload}` per row.
- `delegateLocalFollowups(taskIds)` → `UPDATE campaign_tasks SET status='delegated'
  WHERE id = ANY($1) AND type='follow_up' AND payload->>'sender'='local-browser'`.
  ('delegated' is a new terminal-ish status: not pending, so never re-offered;
  distinct from 'done' so it's auditable as "sent locally".)

**NEW — `campaign-api.js` routes (Bearer-guarded, like the rest):**
- `GET /api/campaign/local-followups?owner=<email>` → `{ followups: [{taskId,
  campaignId, sheetUrl, threadUrl, body, leadUrl, leadName, primaryName,
  primaryUrl, introTitle, profileId, dueAt}] }`. Owner is required; empty list
  if none.
- `POST /api/campaign/local-followups/ack` body `{ taskIds: [...] }` →
  `delegateLocalFollowups` → `{ delegated: n }`.

**Retire** `handleFollowUp`'s personal (`sender==='local-browser'`) branch — it
is now unreachable (the scheduler never hands it a personal follow-up). Keep the
GoLogin branch. `primary-session.js` and `campaign_primaries` become dead code
for this flow; leave in place (harmless), remove in a later cleanup.

**Migration:** existing personal `follow_up` tasks stuck in `status IN
('error','claimed')` or parked → reset to `pending` once so the app drains them
(one-off UPDATE; safe because local send dedupes).

### App (`ortus-gologin-clone`)

**NEW — `src/cloud-followup-poller.js`**: a 60s interval (started at boot,
alongside the primary-runner) that, when an operator email is configured:
1. `GET /api/campaign/local-followups?owner=<operatorEmail>` via campaigns-client.
2. For each returned follow-up, `buildFollowUpTask({ campaignProfileId: fu.profileId,
   sheetUrl: fu.sheetUrl, sender: 'local-browser', threadUrl: fu.threadUrl,
   introTitle: fu.introTitle, leadName: fu.leadName, leadUrl: fu.leadUrl,
   primaryName: fu.primaryName, primaryUrl: fu.primaryUrl, body: fu.body,
   delayMinutes: 0 })` (delay 0 → due now; the engine only offers already-due
   ones) then `enqueuePrimaryTask(task)` (dedupes on
   `follow-up:<profileId>:<leadUrl>`).
3. After ALL enqueues for this batch succeed, `POST .../ack { taskIds }`.
   **Order matters:** ack only after local enqueue, so a crash between GET and
   enqueue re-offers next poll (at-least-once); the local dedupeKey makes the
   re-enqueue a no-op (idempotent).
4. Nudge: if any enqueued follow-up's `dueAt` was older than a threshold (e.g.
   30 min), record a count for the UI ("N late follow-ups are sending now").

**NEW — `src/campaigns-client.js`**: `getLocalFollowups(owner)` and
`ackLocalFollowups(taskIds)` (mirror existing `requestOnce` Bearer calls).

**Reuse (no change):** `primary-task-runner.js` already drains
`sender==='local-browser'` follow-ups from `primary-tasks.json` via the local
browser. Once the poller enqueues, the existing runner sends them.

**Copy fix:** the "⚠ waiting for X to log in" primary-session warning
(`primary-session-render.mjs` / app.js) is misleading — there is no VM login.
Replace with the local-drain reality, e.g. "N follow-up(s) will send from this
machine when the app is open" / the late-nudge count. Remove the needs_login VM
framing for personal primaries.

## Data flow (one lead, end to end)

1. Cloud campaign (owner `antonio@ortusclub.com`, primary `/in/antoniovarlese/`,
   `primarySource='local-browser'`) runs on the VM.
2. Udit accepts; VM sends the intro; VM creates `follow_up` task (sender
   local-browser, dueAt = now + 20 min). VM scheduler ignores it (CHANGE 1).
3. 20 min later the task is due. Antonio's app poller GETs it (owner match),
   `buildFollowUpTask` + `enqueuePrimaryTask`, then acks → engine marks
   'delegated'.
4. Next primary-runner tick (app idle): local browser opens as Antonio, sends
   "Hello Udit, i am Antonio Varlese" in the group thread, logs it in-app. Done.
5. If Antonio's app was closed at step 3, the task stays pending; when he next
   opens the app, the poller pulls it (overdue), the nudge shows the count, and
   it sends on the following idle tick.

## Error handling

- **App closed when due** → task stays pending on the engine; drained + nudged
  on next app open. Expected, not an error.
- **GET/enqueue crash before ack** → re-offered next poll; local dedupe prevents
  a double-enqueue; no double-send.
- **Local send fails** → existing runner retry (`MAX_ATTEMPTS=3` then 'failed');
  engine already 'delegated', so no VM fallback and no re-offer (a personal
  follow-up must never fall back to the VM).
- **GoLogin primary** → never enters this path (`sender` != 'local-browser');
  runs on the VM as today.

## Testing

- Engine: `claimNextDueTask` skips personal follow-ups but still claims GoLogin
  follow-ups + other types (real pg). `getPendingLocalFollowups` owner-scoping +
  due-filter. `delegateLocalFollowups` idempotency. Endpoint tests
  (`GET`/`POST ack`), mirroring the existing `test-*.js` harness.
- App: poller maps engine payload → `buildFollowUpTask` correctly; acks only
  after enqueue; re-poll after a simulated pre-ack crash enqueues no duplicate
  (dedupeKey). Node `--test`, deps injected (no real browser/engine).
- Manual: one cloud CC+IC with Antonio as personal primary → follow-up sends
  from the local browser after the intro; verify the message lands in the thread
  and no VM launch occurs.

## Out of scope

- GoLogin-primary follow-up (unchanged).
- Removing `primary-session.js` / `campaign_primaries` / cookie capture (dead
  after this, but left for a later cleanup pass).
- Any proxy/fingerprint work (rejected by research as insufficient).
