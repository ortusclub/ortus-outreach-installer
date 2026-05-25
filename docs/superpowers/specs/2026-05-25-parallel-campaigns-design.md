# Parallel Campaigns — Design Spec

**Status:** Draft, pending operator review
**Date:** 2026-05-25
**Author:** Sam (with Claude)
**Scope:** Refactor the campaign runtime + UI so multiple campaigns can run simultaneously, each with its own isolated state, log, live-status panel, and action controls. Replaces the current singleton-campaign model.
**Source signal:** Operator (Sam) wants to launch two cohorts in parallel and see each one's progress independently. Today the wizard, log panel, and runbar all show the *global* running campaign regardless of which campaign tab is open — so a new draft tab still shows the other campaign's stats and log lines, and only one campaign can run at a time.

---

## 1. Goal

Two (or more) campaigns can run in parallel. Each campaign owns its own:

- Runtime state (running/paused, current profile, processed counts, errors)
- Log stream
- Live status panel content (cockpit, account queue, bulk-check overlay)
- Action controls (Start / Pause / Stop / Force restart / View status)
- Persisted wizard draft (templates, profiles, daily limit, mode, name, etc.)

The operator's view scopes to the campaign they're currently editing or watching — never bleeds across campaigns. A second campaign can be started only if it doesn't share any active LinkedIn account with a running campaign (account exclusivity).

---

## 2. Non-goals

- **Multi-instance.** Single Electron app instance still enforced via existing single-instance lock.
- **Per-account browser concurrency.** A single GoLogin profile still only drives one browser at a time. Two campaigns claiming the same account is **blocked at start**, not serialized at runtime.
- **Cross-campaign coordination.** No shared rate limiting across campaigns beyond what already exists at the account level.
- **Server-side push to clients.** Polling stays at 2s; no WebSocket / SSE introduced.
- **Backwards compatibility with v2.58 installs.** Data model migrates forward; no need to roll back.

---

## 3. User stories

- **S1.** Operator opens "+ New Campaign", configures it (CC+IB, accounts A/B/C, templates), clicks Start. Campaign A begins. Operator returns to dashboard, clicks "+ New Campaign" again, configures with accounts D/E/F, clicks Start. Both A and B now run in parallel. Each cockpit only shows its own activity.
- **S2.** Operator clicks Edit on Campaign A while B is running. Wizard loads A's saved draft; live status panel + log + action buttons all show A's state. No bleed from B.
- **S3.** Operator on the new-campaign tab (unstarted). Right-pane, log, and live status all show "No activity for this campaign" — even though B is running elsewhere.
- **S4.** Operator tries to start a second campaign that includes an account already used by a running campaign. Start is blocked with a clear modal: "Account `barry.marilao@…` is already running in campaign HELLO_MOTTO. Remove this account or stop HELLO_MOTTO first."
- **S5.** Operator edits Campaign A's wizard, changes the daily limit. Switches tabs to Campaign B without saving. Edits to A are discarded (after a "you have unsaved changes" warning); B's fields show its own saved state, not A's edits.
- **S6.** Operator clicks Save Edits at the top of A's tab. A's draft is persisted to disk; app quit/reopen restores those edits.
- **S7.** Operator on dashboard sees a list of campaigns with per-row status pills: `Running · 16/210`, `Running · 4/120`, `Draft`, `Past · 6 processed`. No global status bar.
- **S8.** Operator hits Force Restart on Campaign A. Only A restarts; B keeps running undisturbed.

---

## 4. Architecture

### 4.1 File changes

```
EDIT   src/campaign.js                — singleton `campaign` object → Map<id, CampaignRuntime>
EDIT   src/paths.js                   — add per-campaign log path helper
NEW    src/campaign-registry.js       — small wrapper around the Map (lookup, list, mutate)
NEW    src/account-lock.js            — start-time check: any account in another running campaign?
EDIT   server.js                      — routes take :id; legacy globals deprecated
EDIT   public/js/app.js               — currentCampaignId everywhere; per-campaign state polling
EDIT   public/index.html              — runbar deleted; Start/Pause/Stop/etc. moved into Live Status section; per-tab Save Edits buttons
EDIT   public/css/style.css           — layout adjustments for in-tab actions; runbar styles removed
NEW    data/campaigns/<id>/           — per-campaign storage (state.json, log.ndjson, draft.json)
EDIT   data/state.json                — repurposed as registry index (id → metadata); per-campaign state moves out
EDIT   electron/main.js               — no changes expected (data dir override already routes everything correctly)
```

**Off-limits:** `src/linkedin/outreach.js` and `src/linkedin/actions.js` are not touched. They already operate on a per-call basis with explicit profile id; nothing in them assumes "the one running campaign."

### 4.2 Runtime model

Today `src/campaign.js` exports a module-level singleton:

```js
export const campaign = { running: false, paused: false, mode: null, currentProfile: null, /* … */ };
```

New shape: a `CampaignRegistry` keyed by `campaignId`. Each entry is a `CampaignRuntime` instance that owns the state and the loop:

```js
class CampaignRuntime {
  id;                    // stable uuid, matches draft id
  name;                  // mirror of draft name for log labels
  status;                // 'idle' | 'running' | 'paused' | 'monitoring' | 'stopped'
  config;                // snapshot of wizard config at start time
  startedAt;
  processedToday;
  totalProcessed;
  errors;
  currentProfile;        // GoLogin id currently driving
  participatingProfileIds; // all profiles assigned to this campaign
  action;                // current step descriptor for cockpit display
  logBuffer;             // in-memory ring (last ~2000 lines), flushed to log.ndjson
  abortController;       // for stop / force-restart
  // … plus the watchdog, parking lot, throttle state currently on the singleton
}
```

`startCampaign`, `pauseCampaign`, `stopCampaign`, etc., become methods on the registry that take an `id`. Existing top-level exports stay for one release as thin wrappers that resolve to "the most-recently-started campaign id" (back-compat shim only — caller migration follows in plan task 2c).

### 4.3 Storage

```
data/
  campaigns.json          ← registry index: [{ id, name, status, startedAt, lastUpdatedAt, … }]
  campaigns/
    <id>/
      state.json          ← serialized CampaignRuntime (sans logBuffer / abortController)
      log.ndjson          ← append-only event log; one JSON object per line
      draft.json          ← persisted wizard draft (per-campaign Save Edits target)
  history.json            ← unchanged; populated when a campaign moves to status=stopped
  state.json              ← deprecated; migration moves contents into per-campaign state.json
```

Atomic writes follow the existing `<file>.tmp` + rename pattern from the CLAUDE.md conventions.

### 4.4 API

All campaign-scoped routes gain an `:id` segment. Examples:

```
POST   /api/campaign                      → create draft, returns { id }
GET    /api/campaigns                     → registry index for dashboard list
GET    /api/campaign/:id                  → full state + recent logs
POST   /api/campaign/:id/start            → start (runs account-lock pre-check)
POST   /api/campaign/:id/pause
POST   /api/campaign/:id/resume
POST   /api/campaign/:id/stop
POST   /api/campaign/:id/force-restart
GET    /api/campaign/:id/logs?since=<ts>  → incremental log poll
PUT    /api/campaign/:id/draft            → Save Edits target
GET    /api/campaign/:id/draft            → load on tab entry
DELETE /api/campaign/:id                  → remove draft + state + logs (history preserved)
```

Legacy `GET /api/campaign/status` returns `{ id: <most-recently-started>, …state }` for one release with a `Deprecation` header — client migration completes in plan task 4b.

### 4.5 Account exclusivity

On `POST /api/campaign/:id/start`:

1. Read incoming config's `profileIds`.
2. Walk the registry, find any other campaign with `status === 'running'` whose `participatingProfileIds` intersect.
3. If non-empty intersection → return 409 with `{ error: 'account_conflict', conflicts: [{ profileId, campaignId, campaignName }, …] }`.
4. UI surfaces a modal listing each conflict with a "Stop <other-campaign>" shortcut.

Monitoring-mode campaigns (status = 'monitoring') do NOT lock accounts — they only poll periodically and don't open the browser concurrently. Confirm with operator before relaxing (open question Q1).

### 4.6 UI scoping

The wizard view is scoped to a `currentCampaignId` (localStorage). `pollStatus()` calls `/api/campaign/:id/...` for the viewed campaign. The existing `isOnNewCampaignView()` helper (added 2026-05-25) is replaced by:

```js
function isViewedCampaignRunning() {
  const id = localStorage.getItem('currentCampaignId');
  if (!id) return false;
  return runningIds.has(id);  // populated by /api/campaigns dashboard poll
}
```

When `isViewedCampaignRunning()` is false → blank cockpit, blank log, blank right-pane (same blanking logic already in place).

### 4.7 Runbar deletion

The bottom sticky runbar is deleted from `public/index.html`. The 6 actions (`START / PAUSE / STOP / VIEW STATUS / FORCE RESTART / SAVED CONFIGS`) move into a new action row at the bottom of the Live Status section, scoped to the viewed campaign. Only visible when:

- The viewed campaign is a draft → only START + SAVED CONFIGS visible
- The viewed campaign is running → all 6 visible
- The viewed campaign is paused → RESUME + STOP visible

### 4.8 Save Edits

Each wizard tab has two buttons (top + bottom). Click writes the current wizard form state to `PUT /api/campaign/:id/draft`. Survives restart. Tab switch without save triggers a modal: "You have unsaved changes to <name>. Save / Discard / Cancel." Defaults to Save on Enter.

---

## 5. Phased rollout

Splitting into phases so each is independently shippable and verifiable:

| Phase | Scope | Risk | Verify |
|---|---|---|---|
| **P1** | Registry skeleton: campaign.js refactored to Map but only one entry ever; existing routes still single-id. No UI changes. | Low — pure refactor with passing tests | `node --test`, run a single campaign end-to-end |
| **P2** | Per-campaign storage layout migration. Existing single campaign reads/writes from `data/campaigns/<id>/`. | Medium — file I/O paths change | Quit + relaunch, confirm running campaign resumes from disk |
| **P3** | API routes accept `:id`. Legacy routes become shims. Client still uses one global campaign. | Medium — many call sites | curl each route; UI still works unchanged |
| **P4** | Client passes `currentCampaignId` everywhere. Dashboard lists campaigns from `/api/campaigns`. | Medium | Two drafts visible in list, edit each, fields persist independently |
| **P5** | Parallel start enabled. Account-lock check enforced. | High — concurrency bugs surface here | Start two non-overlapping campaigns, both run, each has its own log |
| **P6** | UI scoping: runbar deleted, in-tab actions, blank state when viewing inactive campaign. | Medium | Walk through all S1–S8 user stories |
| **P7** | Save Edits buttons + persistence + unsaved-changes guard. | Low | Edit A, switch to B, see warning; reopen app, A's edits intact |

Each phase ends with a commit + auto-relaunch (per operator rule #2) so the user can verify before the next phase starts.

---

## 6. Risks

- **R1 — Watchdog and parking-lot logic is currently global** and assumes one campaign. Need to make per-campaign. May surface dormant bugs (e.g. "park profile" today affects the only campaign — what if a different campaign needs that profile?).
- **R2 — Notifications system** (`src/notifier.js`) sends email/desktop alerts on campaign end. Need per-campaign messages so two campaigns ending at the same time produce two notifications, not one merged one.
- **R3 — Schedule system** (`src/schedules.js`) currently assumes scheduled runs append to the global queue. Needs to attach a campaign id to each scheduled run.
- **R4 — Post-amplification + check-DMs overlays** in `pollStatus()` assume one campaign. Need per-campaign overlay routing.
- **R5 — Off-limits files (`src/linkedin/outreach.js`, `src/linkedin/actions.js`)** are called by the campaign loop with explicit profile id. Should be safe, but every call site needs review to confirm no implicit global state is read.
- **R6 — Existing data migration**. Live operators (Sam, Antonio) have running data in `~/Library/Application Support/The Ortus Outreach/data/`. Migration script must be safe: backup existing files, write new layout, never destructively overwrite.

---

## 7. Open questions — RESOLVED 2026-05-25

- **Q1. Monitoring lock → NO.** Monitoring-mode campaigns do not lock their accounts. Another campaign may use the same account while the first is monitoring.
- **Q2. Parallel cap → NONE.** Hardware-limited. Operator's call how many they start.
- **Q3. Delete mid-edit → confirm-at-delete.** The dashboard's Delete action shows an "Are you sure?" confirmation popup. On confirm, the campaign is deleted AND any open wizard for that campaign is closed back to the dashboard. (No separate "your wizard was open" modal — the single confirm covers both.)
- **Q4. Preset scope → GLOBAL.** Saved Configs stay global; a preset is a reusable starting point applicable to any new campaign.
- **Q5. History concurrent appends.** Internal — coarse-grained per-file mutex around history.json writes, atomic `<file>.tmp` + rename as today. No operator decision needed.

---

## 8. Acceptance

All eight user stories pass via manual verification in the Electron app. Specifically:
- Two campaigns running in parallel show distinct logs in their respective tabs.
- New-campaign tab shows blank state regardless of others running.
- Account exclusivity modal triggers on overlap.
- Save Edits persists across app restart.
- Force Restart of one campaign does not interrupt the other.
- Runbar gone; in-tab action row functional for all states.
