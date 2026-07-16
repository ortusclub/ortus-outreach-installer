# FG Auto-Pilot — Automated Follower Growth on the Cloud VM

**Date:** 2026-07-16
**Status:** Design — awaiting review
**Related:** builds directly on the central roster service (`services/fg-roster`, deployed 2026-07-16) and the cloud FG Team Launch path (`startTeamLaunchCloud`, `src/connections/fg-cloud-launch.js`, tasks 1–8 of the FG-cloud build).

---

## 1. Goal

Follower Growth runs itself. On the **1st and 15th of each month at 06:00 London**, the cloud VM dispatches a full-team FG Team Launch with **no human clicking launch**. The batch is rebuilt live each cycle: every account that has a paired GoLogin profile is included; logged-out and credit-capped accounts are skipped at run time by the engine — exactly as a manual cloud run behaves today.

The whole thing is **on by default with zero configuration**. The FG board shows a single collapsed status strip; anyone with app access can expand it to change the schedule, see who's eligible, review past runs, or fire one manually.

## 2. Why this shape

- **Cloud clock, not the desktop app.** "Automatic" must survive the laptop being closed, so the timer lives on the always-on VM — not the app's `node-cron` (which only ticks while the app is open).
- **Approach A — extend the roster service, don't touch the engine.** The roster service already runs the app's *real* connections code over the connections DB. It becomes the orchestrator. The engine is the drifted reimplementation we are under strict orders never to diverge ([[feedback_vm_must_mirror_local_exactly]]), so it stays **unchanged** — it just receives the same `startCloudCampaign` dispatch a manual run sends.
- **Option 2 — dynamic eligibility.** The batch is "every paired account," and the *real* eligibility (logged in? credits left?) resolves at run time via the engine's existing per-account skip. No fragile cloud pre-flight that duplicates run-time truth.

## 3. Architecture

```
   ┌─────────────┐  publishes fg-autopilot.json        ┌──────────────────────┐
   │  Desktop    │  (paired accounts + keywords +       │  GCS bucket          │
   │  app        │───{enabled, days})──────────────────▶│  ortus-fg-*          │
   │  (source of │  on FG-board open / pairing change   └──────────┬───────────┘
   │   truth)    │                                                  │ read
   └─────────────┘                                                  ▼
                                            ┌───────────────────────────────────┐
   ┌───────────────┐  daily 06:00 London    │  roster service (services/fg-roster)│
   │ GKE CronJob   │───POST /admin/autopilot▶│  • shouldFire(now,cfg,runStore)?   │
   │ (heartbeat)   │   (Bearer)             │  • build leads (existing code)      │
   └───────────────┘                        │  • dispatch → engine startCloud     │
                                            │  • record run (run store)           │
                                            │  • email alert on failure (SES)     │
                                            └──────────────┬──────────────────────┘
                                                           │ startCloudCampaign
                                                           ▼
                                            ┌───────────────────────────────────┐
                                            │  engine (UNCHANGED) — runs the      │
                                            │  batch, per-account skip for        │
                                            │  logged-out / capped accounts       │
                                            └───────────────────────────────────┘
```

## 4. Components

### 4.1 Shared decision module — `src/fg-autopilot.js` (new, pure)

One module, two consumers (app renders "next run"; service decides firing) → no drift. Pure, no I/O, fully unit-testable.

- `cycleKey(date, tz='Europe/London')` → `"YYYY-MM-DD"` for the London calendar day (e.g. `"2026-08-01"`). Identifies a cycle for idempotency.
- `isRunDay(date, days, tz)` → boolean. `days` defaults to `[1, 15]`; true when the London day-of-month is in `days`.
- `nextRun(now, { days, enabled }, tz)` → `Date | null` of the next fire (next day-in-`days` at 06:00 London), or `null` when disabled. Used by the UI strip.
- `shouldFire(now, config, ranCycleKeys, tz)` → `{ fire: boolean, reason: string, cycleKey: string }`.
  Fires only when: `config.enabled` **and** `isRunDay(now,…)` **and** `cycleKey(now)` not in `ranCycleKeys`. `reason` is one of `disabled | not-a-run-day | already-ran | fire`, for logging.

Note: the CronJob guarantees the *time* (06:00 London), so `shouldFire` only reasons about day + enabled + idempotency — never clock time.

### 4.2 Config publisher — app side

- **Shape — `fg-autopilot.json`:**
  ```json
  {
    "enabled": true,
    "days": [1, 15],
    "keywords": ["marketing", "founder"],
    "pairs": [
      { "operator": "…", "operatorName": "…", "account": "…@…", "profileId": "gl-…" }
    ],
    "publishedAt": "2026-07-16T…Z",
    "publishedBy": "ortus@ortusclub.com"
  }
  ```
  `pairs` is exactly the shape the manual launch already builds (`server.js:2422`), minus `local-browser` entries (cloud only). `keywords` = the current role chips.
- **When it publishes:** whenever the FG board is opened, and whenever pairings/keywords/toggle/schedule change. Reuses the connections-DB publish transport (GCS via `gsutil cp`, per `scripts/publish-connections-db.sh`), plus a `POST /admin/refresh`-style nudge so the service reloads immediately.
- **Freshness (known v1 limitation):** the cloud batch reflects the *last published* config. If a new employee is paired but the FG board is never re-opened, they miss the next cycle. Acceptable for v1 — documented, not silently ignored. `publishedAt` is shown in the expanded panel so staleness is visible.

### 4.3 Roster service — new endpoint + orchestration

- `POST /admin/autopilot` (Bearer `FG_ROSTER_TOKEN`, same auth as the existing `/rpc` and `/admin/refresh`). Body: none for the scheduled poke, or `{ force: true }` for the manual "Run now". A `force` run is an explicit human action: it dispatches **regardless of `enabled`, `isRunDay`, or already-ran**, and is recorded under a distinct manual cycle key (`"<YYYY-MM-DD>-manual-<n>"`) so it neither blocks nor is blocked by the scheduled cycle. The only thing it can't do is double-fire an identical manual run while one is still dispatching (guarded by the in-flight record).
- **Flow:**
  1. Load `fg-autopilot.json` (from the pulled config) and the run store.
  2. If not `force`: `shouldFire(now, config, ranCycleKeys)` → if not `fire`, return `{ skipped: true, reason }` (200). Logged; **not** an error alert (a normal off-day skip is not "trouble"). If `force`: skip this gate entirely and proceed.
  3. Build leads from `config.pairs` + `config.keywords` using the existing roster code (`listFgColleaguesMatched` / `buildLeadRows` / `buildCloudLeads`).
  4. Dispatch to the engine via the same path a manual cloud launch uses (`startTeamLaunchCloud` → `startCloudCampaign`), with `name: "Team Follower Growth · <month> · auto"`, `owner`, `month`, `inviteUrl`, `monthlyBudget`.
  5. Record the run in the run store (reuse `makeRunStore`): `{ cycleKey, cloudId, dispatchedAt, status, accounts, invitesPlanned }`. This record is **both** the idempotency guard and the history feed.
  6. On any dispatch failure or errored skip → **email alert** (§4.5) and record `status: "failed"`.
- **Idempotency / guards:** a cycle that already has a run-store record is never re-dispatched (`already-ran`). The cloud engine tolerates concurrent campaigns (per-account Redis lock), so no global "is anything running" gate is needed — the cycle key is the guard.

### 4.4 GKE CronJob — heartbeat

- A `CronJob` at **06:00 Europe/London daily** (`spec.timeZone: "Europe/London"`, `schedule: "0 6 * * *"`) whose only job is a `curl -XPOST` to `/admin/autopilot` with the Bearer token. The *schedule of substance* (which days) lives in `fg-autopilot.json`, so editing it from the app never touches k8s. A daily no-op poke is negligible.
- `concurrencyPolicy: Forbid`, `startingDeadlineSeconds` set, `restartPolicy: OnFailure`, small resource requests. Token from the existing `fg-roster` secret.

### 4.5 Failure alert — email (SES)

- On a failed/errored run only (option 2 — silent on success). `sendAlert(subject, body)` via AWS SES to **antonio@ortusclub.com** and **antoniov@ortusclub.com**.
- Subject: `⚠️ FG Auto-Pilot run failed — <cycleKey>`. Body: cycle, what stage failed, error text, and a one-line "manual Run now from the FG board once fixed."
- Deploy prerequisites: SES sending creds in a k8s secret + a verified sender identity. Flagged as the one new external dependency; no other component needs it.

### 4.6 App UI — the FG board panel

- **Collapsed (default):** the status strip — `AUTO-PILOT · ON/OFF` + next-run (`nextRun(...)`) + cadence + `CLOUD VM` tag + `EDIT SCHEDULE` + the on/off toggle + an **expand chevron**. Matches the approved mockup. Reuses real classes (`.rt-tab` toggle idiom, mono pills, `--green` for the ON dot).
- **Expanded:** three blocks —
  1. **Live eligibility** — the app's existing client-side "Ready to launch" computation (`#fgtl-ready`), reframed as "who *would* fire", rendered with the real `.fgtl-prow` rows (Included / Skipped + reason).
  2. **Recent auto-runs** — from the run store via a service read (`GET`), most recent first: date · accounts fired · invites · skipped · Done/Failed.
  3. **Run now** — `POST /admin/autopilot {force:true}`; lands on the existing `#fgtl-card` live card, tagged "Auto-Pilot launch."
- **Toggle & EDIT SCHEDULE** mutate `{enabled, days}` locally and republish `fg-autopilot.json`. v1: edit **on/off + days**; time fixed at 06:00 (editing time would mean patching the k8s CronJob — out of scope for v1).
- **On-by-default:** ships enabled with `days:[1,15]`. First live 1st/15th after rollout fires automatically. Documented so it is not a surprise.

## 5. Data flow (one cycle)

1. 06:00 London — CronJob POSTs `/admin/autopilot`.
2. Service: `shouldFire` → `fire` (it's the 1st, enabled, not yet run).
3. Build leads from published `pairs` + `keywords` + connections DB.
4. Dispatch → engine; get `cloudId`; write run-store record `status: dispatched`.
5. Engine runs sequentially, skips logged-out/capped accounts per-account.
6. Existing reconcile loop updates counts; sheet write-back as today.
7. App (whenever next opened) shows the run in "Recent auto-runs."
8. On failure at step 3–4 → SES email + `status: failed`.

## 6. Testing

- **`src/fg-autopilot.js` (pure) — the core, fully covered:** `cycleKey` across months/timezones; `isRunDay` for in/out days incl. a London DST boundary; `nextRun` from various "now"s (incl. on a run-day before/after 06:00) and when disabled; `shouldFire` truth table (disabled / off-day / already-ran / fire / force). `node --test`, `assert/strict`.
- **Config builder** (app-side pairs/keywords → `fg-autopilot.json`, dropping `local-browser`) — unit-tested.
- **Orchestration** — the dispatch itself reuses the already-tested `startTeamLaunchCloud`; the new service handler is tested with a stub engine + in-memory run store: fire → dispatch called once + record written; already-ran → no dispatch; disabled → no dispatch; dispatch throws → `failed` record + `sendAlert` called once (SES stubbed).
- No new test for the engine (unchanged).

## 7. Non-goals / v1 simplifications

- **Time not editable from the app** (fixed 06:00 London). Editing days + on/off only.
- **Config freshness depends on the app being opened** at least once after a change. Surfaced via `publishedAt`.
- **No per-account scheduling** — one team-wide batch per cycle.
- **No in-app push** — the app may be closed; email is the only active channel. History panel is the passive record.
- No engine changes.

## 8. Global constraints

- **`src/linkedin/outreach.js` and `src/linkedin/actions.js` are off-limits** — not touched.
- **Engine `campaign-lib/linkedin/*` stays byte-identical to the app** — this design touches none of it (engine unchanged).
- **Never `git add` `data/monitoring-campaign.json`, `data/fg-cloud-runs.json`, or the local `fg-autopilot.json`.** Use targeted `git add`, never `git add -A`.
- **Shared token** `FG_ROSTER_TOKEN` reused; no new public secret. SES creds live only in a k8s secret (gitignored, like `k8s/fg-roster/secret.yaml`).
- **No new DMG / no GitHub push** as part of this work unless separately requested — implementation lands on a branch only.
- Version bump on relaunch per repo convention.
