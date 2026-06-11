# Primary-Side Automation — Design Spec

**Date:** 2026-06-11
**Status:** Draft for review
**Scope:** Two features that ship together as one subsystem. SOO account-status sync (the third feature requested) is **out of scope here** and gets its own spec afterward.

---

## Goal

Add two pieces of primary-side automation to the **Connect + Introduce Back (CC+IC)** flow, both driven from a single queue and a single safe-window runner so the app never opens two browsers at once:

1. **Auto-accept the primary connection.** When a campaign (gologin) account isn't yet connected to the primary person and sends them a connect request, the primary's **local browser** automatically accepts that specific invitation — removing the only manual step that currently blocks the 3-way intro.
2. **Automated first follow-up.** ~10 minutes after the intro is sent, a first follow-up message is posted into the **same group thread**, sent either by **you (local browser)** or by **the campaign account** that ran the intro — operator's choice per campaign.

Both must work across every place an intro can fire today: in-campaign, in monitoring, in the scheduled background sweep, and on "Run bulk check now."

---

## Background — how CC+IC works today (verified against current code)

1. A gologin account (e.g. `patrick.s`) sends a connection request to a cold lead.
2. The connection check (`bulkCheckConnections`) later sees the lead flip to **Connected**.
3. `runAutoIntros` (`src/linkedin/auto-intro.js`) opens a **group thread** with the lead **and the primary person** and sends the intro message. The primary is referenced by **name + URL only — the app never drives the primary's account.**
4. For the intro to include the primary, the campaign account must itself be connected to the primary. `checkAndConnectPrimary` (`src/linkedin/primary-connection.js`, called once per profile at `src/campaign.js:2405`, gated to CC+IC + non-`local-browser` + `primaryUrl` present) reads the primary's degree badge; if the account isn't connected, it sends **one bare connect request** to the primary and the intro is held until accepted.

**The gap this spec fills:** nobody accepts that request. The primary (you) has to accept it by hand in LinkedIn. And there is no automated first follow-up — that message is sent by hand too.

### Verified integration facts

- `runAutoIntros` is the single chokepoint for intros — **4 call sites, all 4 trigger paths:** `src/campaign.js:2213` (campaign batch), `:2991` (in-campaign idle), `:4443` (monitoring / "check now"), `src/post-campaign-bulk-check.js:254` (background sweep). Hooking the follow-up enqueue **inside** `runAutoIntros` covers all four automatically.
- `checkAndConnectPrimary` has exactly **one** call site (`src/campaign.js:2405`), in the campaign batch loop. That is the one place a connect-to-primary is sent, so it is where an `accept` task gets enqueued.
- **There is no accept-invitation function anywhere in the codebase.** Auto-accept is 100% net-new and must live in a **new file** (`src/linkedin/actions.js` and `src/linkedin/outreach.js` are off-limits to modify).
- `launchLocalBrowser()` (`src/local-launcher.js`) returns `{ browser, page }`, runs headed against a persistent cookie profile at `dataPath('local-profile')`, and `closeLocalBrowser()` exists. The local browser is the `'local-browser'` pseudo-profile (display name "You").
- The one-browser invariant currently rests on `campaign.running` (`src/campaign.js:527`, set true at `:1367`, false at `:3717`/`:3889`). **That flag is `false` during monitoring**, so it does not cover monitoring ticks or the two background sweeps. A real lock is needed (see Architecture §3).
- Template fields persist in three slices: in-memory `campaign.templates` (normalized by `normalizeTemplates`, `src/campaign.js:1264`), `monitoring-campaign.json` (whole `templates` object), and per-entry in `post-campaign-bulk-check.json` (currently only `primaryName`, `primaryIntroBody`, `primaryUrl`, `introTitle`). New fields must be threaded through all three.
- `dataPath(...)` (`src/paths.js`) → `./data` in dev, `app.getPath('userData')/data` packaged (via `ORTUS_DATA_DIR`).

---

## Off-limits / constraints

- **Never modify** `src/linkedin/outreach.js` or `src/linkedin/actions.js`. We may **import and call** their primitives (`sendConnectionRequest`, etc.) but not edit them.
- **One campaign / one browser at a time.** The runner must never open a browser while any other browser session is open.
- **Version bump** `package.json` (patch) before each relaunch during build, per standing rule.

---

## Architecture

### Component map

| File | New/Modify | Responsibility |
|------|-----------|----------------|
| `src/primary-tasks.js` | **New** | The queue. Load/persist `data/primary-tasks.json`; `enqueue()`, `listDue(now)`, `markInProgress/Done/Failed/Skipped()`, dedupe, boot-time reset of stuck `in_progress` → `pending`. No browser logic. |
| `src/primary-task-runner.js` | **New** | The safe-window scheduler. 60s tick; only runs when **no browser is open** (`browserSemaphore.getStatus().count === 0`) and `campaign.running` is false; drains due tasks one browser at a time; emits live-log beats via `appendCampaignLog`. |
| `src/browser-semaphore.js` | **Reuse (existing)** | The existing global browser cap already is the "how many browsers are open" counter. The runner routes its launches through `acquire()`/`release()` and gates on `count === 0`. **No new lock file** — `browser-lock.js` is NOT created. |
| `src/linkedin/accept-invitation.js` | **New** | Net-new browser primitives: `readSelfIdentity(page)` (read the logged-in account's own name + profile URL from the global nav) and `acceptInvitationFrom(localPage, { name, profileUrl })` (accept **only** the matching received invitation; never bulk-accept). Its pure matching decision **reuses `normalizeName`/`matchPrimaryCandidate` from `src/linkedin/match-primary.js`**. |
| `src/linkedin/thread-message.js` | **New** | Net-new `sendInThread(page, threadUrl, body, { fallback })` — reopen a known group thread by URL and post a message; fallback to locating it by lead name + intro title. |
| `src/linkedin/auto-intro.js` | Modify | After each successful intro send, capture `page.url()` as the group-thread URL and `enqueue` a `follow-up` task (when follow-up is enabled). |
| `src/campaign.js` | Modify | At `:2405`, after the connect-to-primary is sent, capture the account's self-identity and `enqueue` an `accept` task. Acquire/release the browser lock around the monitoring-tick browser session. Start the runner on boot. Thread new template fields through `normalizeTemplates`. |
| `src/post-campaign-bulk-check.js` | Modify | Acquire/release the lock around its sweep. Persist the new template fields on schedule entries so follow-ups enqueued from the sweep carry the right config. |
| `src/post-campaign-reply-check.js` | Modify | Acquire/release the lock around its sweep. |
| `src/monitoring-persistence.js` | Modify (if needed) | Confirm the new template fields ride along in the persisted `templates` slice. |
| `public/index.html`, `public/js/app.js`, `public/css/style.css` | Modify | Config UI per approved sketch D: required-URL gating, auto-accept toggle, follow-up toggle/message/delay/sender. Add the new fields to the templates payload sent to `startCampaign`. |
| `package.json` | Modify | Version bump. |

### 1. The queue — `data/primary-tasks.json`

A JSON array of task objects. Common fields:

```
id           string   stable id, e.g. `${type}:${profileId}:${leadSlug}:${createdAt}`
type         'accept' | 'follow-up'
status       'pending' | 'in_progress' | 'done' | 'failed' | 'skipped'
createdAt    number   epoch ms
dueAt        number   epoch ms (accept: now; follow-up: introTime + delay)
attempts     number   incremented each run
lastError    string|null
```

`follow-up` adds:

```
sender       'local-browser' | <campaignProfileId>
senderName   string                 (for the log line)
threadUrl    string                 (captured from page.url() at intro send)
introTitle   string                 (fallback thread lookup)
leadName, leadUrl
primaryName, primaryUrl
body         string                 (rendered at enqueue from the template + lead/sender first names)
```

`accept` adds:

```
campaignProfileId, campaignProfileName     the gologin account that must connect to the primary
account: { name, profileUrl }              that account's OWN LinkedIn identity (for invitation matching)
primaryUrl                                 whose invitations the local browser checks (= you)
```

`primary-tasks.js` is pure persistence + selection logic — no Puppeteer. It is the easy-to-unit-test core.

### 2. Enqueue points (no new triggers)

- **Follow-up** — inside `runAutoIntros` (`auto-intro.js`), immediately after a lead's intro send succeeds: read `page.url()` (the page is sitting on the freshly created group thread), render the follow-up body, and `enqueue({ type:'follow-up', dueAt: Date.now() + followUpDelayMinutes*60_000, sender: followUpSender, threadUrl, ... })`. Because all four intro paths flow through `runAutoIntros`, this is the only place we touch — follow-ups work everywhere automatically. Skipped entirely when `followUpEnabled` is false.
- **Accept** — at `campaign.js:2405`, when `checkAndConnectPrimary` reports `connectAttempted` / `connectResult==='sent'`: capture the campaign account's self-identity via `readSelfIdentity(page)` (the account's browser is open right there) and `enqueue({ type:'accept', dueAt: Date.now(), campaignProfileId, account:{name,profileUrl}, primaryUrl, ... })`. Skipped when `autoAcceptPrimary` is false.

### 3. The runner + the browser semaphore (the load-bearing safety mechanism)

The app **already has** a global browser cap, `src/browser-semaphore.js` (`acquire()`/`release()`/`getStatus()`), and `campaign.js` routes every launch through it. The gap: the two **background sweeps do not acquire it today** (`post-campaign-bulk-check.js`, `post-campaign-reply-check.js` launch directly), so the semaphore count under-reports. This spec **closes that gap** by wrapping the sweep launches in `acquire()`/`release()` too — after which `browserSemaphore.getStatus().count` is the true count of open browsers across the whole app.

`src/primary-task-runner.js` ticks every 60s and proceeds only when **`campaign.running === false` AND `browserSemaphore.getStatus().count === 0`** (nothing else has a browser open — the "no account busy" condition). It then `acquire()`s a slot, re-checks `!campaign.running`, and launches. When it proceeds:

1. `listDue(now)` → due `pending` tasks.
2. Partition by the browser each needs: **local-browser bucket** = all `accept` tasks + `follow-up` tasks with `sender==='local-browser'`; **per-account buckets** = `follow-up` tasks grouped by `campaignProfileId`.
3. Process **serially, one browser at a time**, each wrapped in `browserSemaphore.acquire()` … `release()` (in a `finally`):
   - **Local bucket:** `acquire()` → `launchLocalBrowser()` → for each task: `acceptInvitationFrom(...)` or `sendInThread(...)` → mark each → `closeLocalBrowser()` → `release()`.
   - **Each account bucket:** `acquire()` → `launchProfile(profileId, token)` → send each follow-up via `sendInThread` → mark → `closeProfile(profileId)` → `release()`.
4. Emit live-log beats throughout (§6).

This guarantees "never two browsers at once" **including during monitoring**, which the current `campaign.running`-only gate does not.

### 4. Auto-accept mechanics

- `readSelfIdentity(page)` reads the logged-in account's own display name + profile URL from the global nav ("Me") — called on the **campaign account's** page at enqueue time and stored on the task.
- `acceptInvitationFrom(localPage, { name, profileUrl })` runs on the **local browser** (= the primary, you): open the received-invitations view, scrape the candidate sender names, pick the match using the **existing** `matchPrimaryCandidate(candidates, name)` from `src/linkedin/match-primary.js` (corroborated by `profileUrl` when present), click **Accept** for that one only. **If no match is found, accept nothing**, log it, and mark the task `skipped` (likely already accepted/withdrawn). Never bulk-accept.
- Once the account is connected to you, the existing hold resolves on its own: the next batch/monitoring turn's `checkAndConnectPrimary` re-reads the degree as 1st and the held intro fires. No extra wiring.

### 5. Follow-up mechanics

- `sendInThread(page, threadUrl, body, { fallback })`: navigate to `threadUrl`; if the thread loads and the composer is present, type and send `body`. If the URL is stale, fall back to locating the thread by lead name + intro title in the messaging list; if still not found, mark `failed` with a clear error.
- Tokens supported in the follow-up body: `{first name}` (from the lead), best-effort `{company}` if present on the sheet row. Rendered **at enqueue** with the **existing** `personalizeTemplate(template, data)` from `src/linkedin/helpers.js` (the same renderer the intro uses), so the stored `body` is final text.
- Sender is whatever the operator chose: `local-browser` (you) or the `campaignProfileId` that ran the intro. Both are participants in the group thread, so either can post.

### 6. Live log (no new UI card)

Sketch E (the status card) is dropped. The only UI surface beyond the config form is the **existing live log**, which gains major beats emitted by the enqueue points and the runner, using the current log channel:

```
⏳ Follow-up queued — {lead} · due {time} · from {you|account}
🔗 {account} not connected to primary — connect sent · auto-accept queued
🖥 Opening your local browser (no account busy) — {n} accept + {m} follow-ups due
✓ Connection accepted — {account} (via your local browser)
✓ Follow-up sent — {lead} (group chat) · from {sender}
🖥 Local browser closed — queue clear
```

---

## Data flow (happy path)

**Auto-accept:** campaign batch turn → account X not connected to you → `checkAndConnectPrimary` sends connect to you → `readSelfIdentity(X.page)` → enqueue `accept` (due now). Send loop ends → idle gap → runner acquires lock, opens local browser, `acceptInvitationFrom` accepts X's invite, closes → next monitoring turn: X reads as 1st → held intro fires.

**Follow-up:** intro sends inside `runAutoIntros` → capture thread URL → enqueue `follow-up` (due intro+10m) → at first idle gap ≥ due time, runner opens the chosen browser (local or X), `sendInThread` posts the message in the group thread, closes.

---

## Error handling

- **Local browser not signed in** (cookies expired): accept/follow-up can't proceed → mark `failed` with "local browser not signed in — open it once to log in"; cap `attempts` (e.g. 3) then stop retrying. Never blocks the campaign.
- **Invitation not found:** `skipped` (treat as already-connected), logged.
- **Stale thread URL:** fallback lookup; if still missing → `failed` + log.
- **Lock busy / campaign running:** runner does nothing this tick; retries next tick.
- **Crash safety:** statuses persisted to JSON; on boot, `in_progress` → `pending` so an interrupted task reruns.
- **Never block outreach:** any primary-task failure is contained to the queue; the campaign and intros are unaffected.

---

## Testing strategy

- **`primary-tasks.js`** (pure, no browser): enqueue, `listDue` time filtering, dedupe, status transitions, boot reset of `in_progress`.
- **`browser-lock.js`**: acquire/release, `isLocked`, double-acquire rejected, release-by-non-owner guarded.
- **`primary-task-runner.js`** task-selection: with the lock free vs held, `campaign.running` true vs false, due vs not-due, correct partition into local vs per-account buckets — browser launch injected/mocked.
- **Token rendering**: `{first name}`/`{company}` substitution.
- **Accept matching decision**: given a list of candidate invitations + a target identity, picks the match or returns "no match" — unit-tested on the decision, DOM selectors hardened during build.
- **Enqueue-on-intro**: a fake `page` with a known `url()` proves `runAutoIntros` enqueues one follow-up per successful intro and none when disabled.

(DOM-level accept/send primitives are verified manually against LinkedIn during build, as with existing `actions.js` primitives.)

---

## Out of scope (separate specs)

- **SOO account-status sync** (#3) — its own spec next; will require column-mapping answers (which column flips to in-use, dropdown vs free text, where the login email goes, the needs-login value, edit access).
- Structural fix for the "visible ⟺ running" monitoring invariant / patrick.s phantom — the browser lock added here narrows that gap but the full fix is separate.
- DM / InMail modes (parked).

---

## Open decisions — resolved

- Build order: primary-side (this spec) first; SOO after. ✓
- Follow-up sender: operator picks **you (local browser)** or **the campaign account**. ✓
- Accept matching: **by the campaign account's captured identity**; no match → skip, never bulk-accept. ✓
- Campaign-account follow-up timing: runner **opens the account in an idle gap**. ✓
- Auto-accept gating: locked in the UI until the primary URL is set. ✓
