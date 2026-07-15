# FG Team Launch → Cloud VM — Design Spec

**Date:** 2026-07-15
**Status:** Approved (design) — ready for implementation plan
**Repos:** `ortus-gologin-clone` (app) + `ortus-salesnav-scraper-cloud` (engine)

## Goal

When the operator has the **☁︎ Cloud VM** run-target selected, the Follower Growth
**Team Launch** button dispatches the batch to the cloud engine instead of running
it locally on the laptop — running the accounts **in parallel** on the VM, with a
durable **proof** trail and a **write-back to the FG sheet** that matches a local run
1:1, and that completes even if the operator closes the laptop.

## Problem (current state)

- FG mode replaces the normal campaign apparatus with the Team Launch workspace
  (`public/js/app.js:2685` → `initFollowerGrowth()`; `2691` hides `navLaunch`).
- The workspace's **LAUNCH N SEQUENTIALLY** button always POSTs to
  `/api/fg/team-launch/start` (`public/js/app.js:17640`), which runs the batch
  **locally and sequentially** (`server.js:2379` → `runTeamLaunch`), **ignoring the
  run-target tab**. With Cloud VM selected, the run still executes on the laptop.
- Everything the cloud needs already exists but is unreachable:
  - Engine `follower_growth` is implemented and wired (`campaign-followergrowth.js`,
    `campaign-runtime.js:58,232`), with a passing runtime test.
  - The engine's `POST /api/campaign/start` accepts a **`leads[]` array** with a
    per-lead **`routeAccount`** (`campaign-api.js:73-88`), and `claimNextLead`
    scopes claims per account (`campaign-store.js:119`: `route_account = '' OR
    route_account = $account`).
  - `campaigns-client.js` already lists `follower_growth` in `CLOUD_MODES` and
    `startCloudCampaign` already sends `leads` with `routeAccount`.

So this is **not** a from-scratch build: it wires the existing Team Launch flow to
the existing engine transport, and adds the write-back reconciler.

## Non-goals

- No change to the **local** Team Launch path (`runTeamLaunch`) — it stays exactly
  as-is.
- No new FG orchestration model. The engine's per-account `follower_growth` batch is
  the target; the app supplies each account's targets.
- `src/linkedin/outreach.js` and `src/linkedin/actions.js` are **off-limits**.
- No app DMG published. Engine changes are committed **locally only**.

## Approach (chosen: B — server-side branch)

`initFollowerGrowth` already POSTs to `/api/fg/team-launch/start`, and the
build+run already happen **server-side** (`src/connections/*`). The cloud path lives
in the same route, branching on a `target` field. This keeps build → dispatch →
write-back together where the FG data already lives (the FG sheet + Connection DB),
and keeps the client a thin toggle.

Rejected alternatives:
- **A — client dispatches.** `buildFgTargets` and the FG sheet I/O are server-side;
  write-back must be server-side. The client cannot own this.
- **C — engine builds targets from a synced Connection DB.** The Connection DB is
  app-side; the engine has no access.

## Architecture

### Client (`public/js/app.js`)
- The Team Launch launch button reads the run-target (`getRunTarget()`), and POSTs
  `/api/fg/team-launch/start` with `target: 'cloud' | 'local'` (default from the
  tab; `'local'` preserves today's behavior).
- Under Cloud VM, the button copy changes (e.g. **"Launch N in cloud"**); on a
  successful dispatch the client hands off to the existing cloud card via
  `openCloudLive(cloudId)` (parity with a normal cloud launch — see
  `feedback_two_live_status_cards`).
- No client-side target building, dispatch, or write-back.

### Server route (`server.js` — `/api/fg/team-launch/start`)
Branch on `b.target`:
- `'local'` (or absent) → **unchanged** current path (`runTeamLaunch`).
- `'cloud'` → new `startTeamLaunchCloud(pairs, { keywords, month, owner })` in a new
  module (see below). Returns `{ started: true, cloudId }`.

### New module: `src/connections/fg-cloud-launch.js`
Owns the cloud dispatch + reconcile. Pure functions where possible; I/O injected as
`deps` for unit tests (mirrors the `runTeamLaunch` deps seam).

1. **`buildCloudLeads(pairs, ctx, deps)`** — for each pair, call the SAME builder the
   local path uses:
   `buildFgTargets(fgCriteria({ jobTitles: keywords }), { operator, operatorName,
   account, month, alreadyInvited, budget })`
   where `alreadyInvited` / `budget` come from a single `getFgState()` snapshot
   (dedupe vs already-invited; budget-capped) — identical to `server.js:2402-2415`.
   Returns `{ perAccount: [{ account, operator, month, rows }], leads }` where each
   engine lead is built from an FG row `r` (column indices from `fg-export.js`
   `FG_HEADER`: `I_NAME=0`, `I_URL=1`, `I_MEMBER=2`, `I_COMPANY=3`, `I_TITLE=4`):
   ```js
   {
     leadUrl:     r[1],                       // LinkedIn URL — REQUIRED (engine filters empties)
     fullName:    r[0],                        // modal picker searches by name
     memberUrn:   null,
     routeAccount: pair.profileId,             // pins the lead to this account
     row:         { memberId: r[2], name: r[0], company: r[3], title: r[4] },
   }
   ```

2. **Dispatch** — `startCloudCampaign({ mode: 'follower_growth', name, owner,
   profileIds: pairs.map(p => p.profileId), leads, inviteUrl: ORTUS_PAGE_INVITE_URL,
   monthlyBudget: FG_DEFAULT_MONTHLY_ALLOWANCE, config: { inviteUrl, monthlyBudget } })`.
   - On error → return the error; **do not** write anything to the FG sheet (clean
     failure — no stranded Queued rows).

3. **Proof-at-launch** — only **after** a successful dispatch, `queueFgInvites(allRows)`
   stamps every target **Queued** on the FG sheet. Survives the laptop closing.

4. **Durable reconcile record** — atomic JSON write (`<file>.tmp` → rename, per repo
   convention) to `data/fg-cloud-runs.json`: an array of
   `{ cloudId, month, dispatchedAt, status: 'dispatched', perAccount: [{ account,
   operator, month, rowsByUrl: { <leadUrl>: <memberId> } }] }`.
   `rowsByUrl` is the map the reconciler uses to turn invited `lead_url`s back into
   LinkedIn Member IDs (the engine echoes invited leads by its own `lead.id`, so the
   app cannot rely on the engine to return the LinkedIn memberId — it maps locally).
   **Never** `git add` this file.

### Reconciler (`src/connections/fg-cloud-launch.js` + startup hook)
- **`reconcileCloudRun(record, deps)`** — idempotent:
  1. `getCloudCampaign(cloudId)`; if status ∉ `{done, error, stopped, cancelled}`,
     leave `status: 'dispatched'` and return (poll again later).
  2. `getCloudCampaignLeads(cloudId)` → per-lead `{ lead_url, status, stage,
     assigned_profile }`.
  3. Invited = leads with `stage === 'Invited'` (engine stamps `markLead(id,'sent',
     {stage:'Invited'})`). Group by `assigned_profile` → the account (via `perAccount`).
  4. Per account: map invited `lead_url` → memberId via `rowsByUrl`; then the SAME
     write-back the local `record` dep does (`server.js:2426-2454`):
     - `queueFgInvites(persistRows)` is already done at launch; here call
       `markFgInvited({ memberIds, account, operator, month })` (Queued→Invited +
       Invited-At + budget bump).
     - `observeFgCredits({ account, operator, month, available, allowance, refill })`
       from the engine's per-account credit snapshot (see engine change below).
     - **Best-effort**: on sheet-write failure, log a loud **STRANDED** warning and
       do NOT throw — the engine remains source of truth and the next reconcile
       re-flips. (Verbatim policy from `server.js:2434-2446`.)
  5. Set `record.status = 'reconciled'`; atomic write.
- **Poller** — while the app is open, poll dispatched records on an interval (reuse
  the existing cloud-status cadence). **Startup hook** — on boot, run
  `reconcileCloudRun` for every record still `'dispatched'`, so a run that finished
  while the laptop was closed is written back on next open.

### Engine (`ortus-salesnav-scraper-cloud`, committed locally only)
1. **Parity check + test** — confirm `runFollowerGrowth` maps each claimed lead's
   `full_name` (and `row_data`) into the `queued` shape `sendInvites` needs
   (`campaign-followergrowth.js:68-76` already does: `name: l.full_name`,
   `memberId: String(l.id)`), uses the per-campaign `inviteUrl`, and honors routed
   claiming. Add `test-campaign-followergrowth.js` cases asserting: (a) a lead with
   `route_account = accX` is only claimed by `accX`; (b) `full_name` flows into the
   modal-picker `queued` name.
2. **Expose per-account credit snapshot** — `runFollowerGrowth` already computes
   `creditsAfter` / `allowance` / `refill` per account; persist them (per campaign ×
   account) and expose via the campaign or leads API so the app's `observeFgCredits`
   has real numbers. This is the only additive engine change. If per-account credit
   exposure is deferred, `observeFgCredits` is skipped (budget still self-corrects
   from the `Sent` count) — flagged, not blocking.

## Data flow (end to end)

```
Operator (Cloud VM tab) → LAUNCH N in cloud
  client POST /api/fg/team-launch/start { target:'cloud', pairs, keywords, month }
    server: snap = getFgState()
            perAccount,leads = buildCloudLeads(pairs, {keywords,month,snap})
            { cloudId } = startCloudCampaign({mode:'follower_growth', leads, profileIds, inviteUrl, monthlyBudget})
            queueFgInvites(allRows)                    ← FG sheet: Queued (proof-at-launch)
            persist data/fg-cloud-runs.json            ← durable reconcile record
    client: openCloudLive(cloudId)                     ← existing cloud card (card #2)

Engine (parallel per account):
    per account: claimNextLead(route_account) → runFollowerInvites(modal) → markLead 'sent'/'Invited'
                 + markActionSent(anti-dupe)           ← Postgres: proof of VM work

Reconcile (poller while open + startup hook):
    getCloudCampaign(cloudId) done? → getCloudCampaignLeads
    group invited by assigned_profile → memberIds via rowsByUrl
    markFgInvited(memberIds, account, operator, month) ← FG sheet: Queued→Invited
    observeFgCredits(...)                               ← FG sheet: credit snapshot
    record.status = 'reconciled'
```

## Proof (two independent records)
- **Engine Postgres** — per-lead `sent` / `stage='Invited'` rows + `markActionSent`
  anti-dupe markers = durable proof of what the VM actually did.
- **FG sheet** — Queued at launch → Invited on completion + credit snapshot = the
  operator-facing record and the dedupe source for the next run. Works whether or
  not the laptop stayed open. This is the "sheet fallback."

## Error handling
| Failure | Behavior |
|---|---|
| Engine unreachable at dispatch | Return error to client; **no** FG-sheet writes (clean failure). |
| Engine reachable, some leads have empty URL | Engine filters them; app's builder only emits rows with a URL (`r[1]`). |
| FG-sheet write fails during reconcile | Loud **STRANDED** warning, no throw; engine is source of truth; next reconcile re-flips. |
| App closed mid-run | Startup hook reconciles finished runs on next open. |
| Reconcile runs twice | Idempotent: `markFgInvited` flips Queued→Invited (already-Invited is a no-op); status guard prevents double credit writes. |
| Per-account credit not exposed by engine (deferred) | Skip `observeFgCredits`; budget self-corrects from `Sent` count. |

## Testing
Pure unit tests (`node --test`, per repo convention):
- **app** `buildCloudLeads`: FG rows → engine leads with correct `routeAccount`,
  `leadUrl=r[1]`, `fullName=r[0]`, `row.memberId=r[2]`; empty-URL rows dropped;
  `rowsByUrl` map correct.
- **app** `reconcileCloudRun`: cloud invited leads → correct `markFgInvited` args per
  account; non-terminal status → no write; second run is a no-op (idempotent);
  sheet-write failure → STRANDED, no throw.
- **engine** `test-campaign-followergrowth.js`: routed claim isolation; `full_name`
  into `queued`.

Integration-only (flagged, not unit-tested, consistent with the repo): the actual
`startCloudCampaign` HTTP dispatch, the engine browser/modal send, the cloud card
live view. Manual verification via `npm run dev:app` + the cloud card.

## Files

**app (`ortus-gologin-clone`)**
- Create: `src/connections/fg-cloud-launch.js` (buildCloudLeads, dispatch, reconcile)
- Create: `tests/fg-cloud-launch.test.js`
- Modify: `server.js` (`/api/fg/team-launch/start` target branch; startup reconcile hook)
- Modify: `public/js/app.js` (launch button reads run-target → `target`; cloud copy;
  `openCloudLive` hand-off)
- Data (gitignored): `data/fg-cloud-runs.json`

**engine (`ortus-salesnav-scraper-cloud`) — committed locally only**
- Modify: `test-campaign-followergrowth.js` (routed claim + name-mapping cases)
- Modify (if in scope): per-account credit snapshot persistence + API exposure
  (`campaign-followergrowth.js` / `campaign-store.js` / `campaign-api.js`)

## Global constraints
- Off-limits: `src/linkedin/outreach.js`, `src/linkedin/actions.js`.
- Local Team Launch path unchanged.
- Engine changes committed locally only; no app DMG published.
- `data/fg-cloud-runs.json` never `git add`ed.
- Atomic JSON writes (`.tmp` → rename). Auto-send defaults OFF (N/A here — no new
  notifications).
- Bump `package.json` + both `index.html` `?v=` tags before relaunching dev:app.
