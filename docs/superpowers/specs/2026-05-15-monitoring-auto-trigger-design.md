# Monitoring Auto-Trigger (Bulk Check + Auto-Intro) Design

**Date:** 2026-05-15
**Status:** Approved — ready for implementation plan
**Scope:** `connect_and_introduce` (CC+IC) mode only

## Problem

The campaign's monitoring state currently displays `🛏 Monitoring · next check at HH:MM` in the cockpit and run-bar, but **nothing in the codebase actually fires a check at that time.** `campaign.nextCheckAt` is purely cosmetic. The post-campaign sweep scheduler (`src/post-campaign-bulk-check.js`) exists and works, but the UI never sends `acceptanceTrackingDays > 0`, so no entry is ever registered with it. Result: the operator launches a CC+IC campaign, sees a promised "next check at 04:35," waits all night, and nothing happens. The only way to trigger a check is the manual "Check now" button.

Verified by reading `~/Library/Application Support/The Ortus Outreach/data/post-campaign-bulk-check.json` → `{}` after the most recent CC+IC campaign.

## Goals

1. The cockpit's `next check at HH:MM` becomes a real promise — an automatic bulk-check + auto-intro pass actually fires at that time.
2. The cadence is operator-configurable per campaign at launch time.
3. Survives macOS laptop sleep — when the lid opens, any overdue check fires immediately.
4. Survives Electron app restart — persisted on disk, rehydrated by existing `resumeMonitoringFromDisk`.

## Non-goals

- No mid-campaign cadence editing (relaunch to change).
- No automatic catch-up of multiple missed slots (one batched fire on wake covers the whole missed window).
- No new behavior for `connect_only` mode — the existing post-campaign scheduler continues to serve that mode unchanged.
- No exposure of cadences faster than 15 min (LinkedIn API protection).

## Architecture

Approach B+C from brainstorming: a new monitoring tick driven by `campaign.nextCheckAt`, plus an Electron `powerMonitor.on('resume')` hook for sleep-resume.

```
Launch wizard
  └─ Dropdown: Auto-check & intro cadence (15m … 6h, default 1h)
                            │
                            ▼ POST /api/campaign/start { ..., checkIntervalMinutes }
                            │
                       startCampaign({ ..., checkIntervalMinutes })
                            │
                  campaign.checkIntervalMinutes = N
                            │
                       ... campaign sends ...
                            │
                  transitionToMonitoring
                  ├─ state = 'monitoring'
                  ├─ nextCheckAt = now + N*60_000
                  └─ writeMonitoringState(campaign)   [persists to disk]
                            │
                            ▼
        ┌─────────── 60s tick (_monitoringWatcherTimer) ────────────┐
        │                                                            │
        │  if state !== 'monitoring' → noop                          │
        │  if Date.now() >= monitoringUntil → stopMonitoring         │
        │  if Date.now() <  nextCheckAt → noop                       │
        │  if _checkInProgress → skip                                │
        │  else:                                                      │
        │     _checkInProgress = true                                 │
        │     await runMonitoringCheckAll()  [bulk-check + intros]   │
        │     if state === 'monitoring':                              │
        │       nextCheckAt = now + N*60_000                          │
        │       writeMonitoringState(campaign)                        │
        │     _checkInProgress = false                                │
        │                                                            │
        └────────────────────────────────────────────────────────────┘
                            │
                            ▼ (on macOS lid open)
        electron/main.js: powerMonitor.on('resume')
                            │
                            ▼ POST /api/monitoring/wake
                            │
                  tickMonitoringNow()  [same body as 60s tick, one-shot]
```

## Operator UX — the cadence picker

**Where:** Launch wizard, in the "Acceptance & monitoring" section. Visible **only when Mode = Connect + Introduce Back**.

**Markup shape:**

```
┌─ Acceptance & monitoring ─────────────────────────────┐
│                                                       │
│  Auto-check & intro cadence                           │
│  Every  [ 1 hour ▾ ]                                  │
│  ─────────────────────                                │
│  How often the app re-checks for new acceptances and  │
│  fires the intro DM during the 7-day monitoring       │
│  window. Faster cadences increase LinkedIn API load.  │
│                                                       │
└───────────────────────────────────────────────────────┘
```

**Dropdown values:** 15 min · 30 min · 1 h · 1.5 h · 2 h · 3 h · 6 h
**Default:** 1 hour
**Server clamp:** `[15, 360]` minutes — values outside this range are clamped at the API boundary to ignore tampering.

**Payload field:** `checkIntervalMinutes: 60` on `POST /api/campaign/start`.

## Scheduler tick — implementation

Extend the existing `_monitoringWatcherTimer` in `src/campaign.js:3072` (already a `setInterval(60s)` watching the 7-day window). Adding a second responsibility to the same timer keeps surface area small.

```js
let _checkInProgress = false;

export function startMonitoringWatcher() {
  if (_monitoringWatcherTimer) return;
  _monitoringWatcherTimer = setInterval(tickMonitoringNow, 60_000);
}

export async function tickMonitoringNow() {
  try {
    if (campaign.state !== 'monitoring') return;

    // Duty 1: 7-day window expiry (existing behavior)
    if (campaign.monitoringUntil && Date.now() >= new Date(campaign.monitoringUntil).getTime()) {
      await stopMonitoring({ reason: 'window-elapsed' });
      return;
    }

    // Duty 2: fire bulk-check + auto-intros when nextCheckAt is overdue
    if (!campaign.nextCheckAt) return;
    if (Date.now() < new Date(campaign.nextCheckAt).getTime()) return;
    if (_checkInProgress) return;

    _checkInProgress = true;
    try {
      const cadenceMin = campaign.checkIntervalMinutes || 60;
      campaign.logs.push(`[${new Date().toISOString()}] 🛏 Monitoring · auto-check starting (cadence=${cadenceMin}m)`);
      await runMonitoringCheckAll();
    } finally {
      if (campaign.state === 'monitoring') {
        const ms = (campaign.checkIntervalMinutes || 60) * 60_000;
        campaign.nextCheckAt = new Date(Date.now() + ms).toISOString();
        try { await writeMonitoringState(campaign); } catch { /* */ }
        const hhmm = `${String(new Date(campaign.nextCheckAt).getHours()).padStart(2,'0')}:${String(new Date(campaign.nextCheckAt).getMinutes()).padStart(2,'0')}`;
        campaign.logs.push(`[${new Date().toISOString()}] 🛏 Monitoring · next check at ${hhmm}`);
      }
      _checkInProgress = false;
    }
  } catch (err) {
    console.warn('[monitoring-tick] threw:', err.message);
    _checkInProgress = false;
  }
}
```

Key properties:
- **60s heartbeat** is trivial; the expensive `runMonitoringCheckAll` only runs when actually due.
- **Re-entrancy safe** via `_checkInProgress`.
- **Stop-monitoring during check** is handled: the post-fire reschedule block checks `state === 'monitoring'` before recomputing `nextCheckAt`.
- **No new file** — extends the existing watcher.

## Wake handler — macOS sleep-resume

**Problem:** Node's monotonic clock doesn't advance during macOS sleep. After a long lid-close, `setInterval(60s)` could be 5+ minutes late to fire its first post-wake tick.

**Fix:** opportunistic wake hook.

`electron/main.js`:
```js
import { powerMonitor } from 'electron';

powerMonitor.on('resume', () => {
  fetch(`http://127.0.0.1:${SERVER_PORT}/api/monitoring/wake`, { method: 'POST' })
    .catch((err) => console.warn('[wake] ping failed:', err.message));
});
```

`server.js`:
```js
app.post('/api/monitoring/wake', async (_req, res) => {
  const { tickMonitoringNow } = await import('./src/campaign.js');
  tickMonitoringNow().catch((err) => console.warn('[wake] tick threw:', err.message));
  res.json({ ok: true });
});
```

The endpoint reuses the exact same `tickMonitoringNow` function the timer calls. Single code path, no duplication.

**Catch-up semantics:** if 3 cadence boundaries elapsed during sleep, only **one** check fires on wake. After it completes, `nextCheckAt` jumps forward by one cadence and normal 60s ticks resume.

**App-killed-during-sleep path:** if the Electron app was killed entirely (not just suspended), `resumeMonitoringFromDisk` (already exists, `server.js:2151`) rehydrates the campaign global from `data/monitoring-campaign.json`. The first 60s tick after boot sees `nextCheckAt` is overdue and fires immediately. The wake hook is only relevant for the "app stayed open through sleep" path.

## Persistence

Add `checkIntervalMinutes` to `MONITORING_FIELDS` in `src/monitoring-persistence.js` so the cadence survives app restart along with `nextCheckAt`. If missing on disk (older state file from before this ships), `tickMonitoringNow` defaults to 60.

## UI feedback during a check

The cockpit and run-bar already poll `getCampaignStatus()` every 4s. When a tick fires, the existing `📡 bulk check pass starting…` log line appears immediately. The cockpit's monospace `next 04:35 · ends in Xd Yh` line flips to `checking now…` while `_checkInProgress` is true, then back to `next HH:MM` once `nextCheckAt` is rescheduled.

This adds a small `_checkInProgress` field to the `getCampaignStatus` payload and a corresponding display branch in `public/js/app.js`.

## Behavior contract — edge cases

| Scenario | Behavior |
|---|---|
| Operator hits "Stop monitoring" mid-check | In-flight check completes (browser cleanup, log lines). Post-fire reschedule is skipped because `state !== 'monitoring'`. No zombie `nextCheckAt`. |
| Cadence changed mid-campaign | Not supported. Cadence is fixed at launch. Stop + relaunch to change. |
| Bulk-check takes longer than cadence | Re-entrancy guard skips overlapping ticks. Next fire happens immediately after the previous completes. Acceptable because realistic check duration (~10-60s) is far below the 15min floor. |
| App relaunched during monitoring | `resumeMonitoringFromDisk` rehydrates campaign including `checkIntervalMinutes`. First post-boot tick sees overdue `nextCheckAt` and fires. |
| Multiple ticks log the same fire | Cannot happen — `_checkInProgress` is module-scoped and the timer is a single `setInterval`. |
| Bulk-check throws | Caught in outer try/catch. `_checkInProgress` reset in `finally`. Next tick (60s later) sees overdue `nextCheckAt` and retries. |

## Files touched

| File | Change |
|---|---|
| `src/campaign.js` | Accept `checkIntervalMinutes` param in `startCampaign`, store on `campaign`. Extend `_monitoringWatcherTimer` callback into a named `tickMonitoringNow` exported function. |
| `src/campaign-state-transitions.js` | `transitionToMonitoring` reads `campaign.checkIntervalMinutes`, uses it to compute initial `nextCheckAt`. |
| `src/monitoring-time.js` | `recomputeNextCheckAt` signature accepts cadence in minutes. |
| `src/monitoring-persistence.js` | Add `checkIntervalMinutes` to `MONITORING_FIELDS`. |
| `server.js` | `POST /api/campaign/start` accepts `checkIntervalMinutes`, clamps `[15, 360]`, passes through. New endpoint `POST /api/monitoring/wake` calling `tickMonitoringNow`. |
| `electron/main.js` | `powerMonitor.on('resume')` → fetch `/api/monitoring/wake`. |
| `public/index.html` | New `<select>` markup in launch wizard, conditional-visible for CC+IC mode. |
| `public/js/app.js` | Read the dropdown value, include `checkIntervalMinutes` in start payload. Show `checking now…` in cockpit monospace line when `_checkInProgress`. |
| `public/css/style.css` | Minor styling for the new wizard row (matches existing wizard rows). |

## Out of scope

- Mid-campaign cadence editing.
- Cadence visible in `connect_only` mode.
- Multi-slot catch-up on wake (we fire once).
- Notification email on auto-check completion (existing pre-sweep email from `notifyDueSweeps` is `connect_only`-side; CC+IC monitoring is silent by design).
- Telemetry / metrics on how many checks fire per campaign.

## Test plan

- **Unit:** `tickMonitoringNow` with mocked clock and a stubbed `runMonitoringCheckAll` — verify no-op when not due, fires when due, skips when `_checkInProgress`, recomputes `nextCheckAt` after fire, skips reschedule when stopped mid-fire.
- **Unit:** `transitionToMonitoring` uses `checkIntervalMinutes` to compute `nextCheckAt`.
- **Unit:** `monitoring-persistence` round-trips `checkIntervalMinutes`.
- **Unit:** `server.js` clamps `checkIntervalMinutes` to `[15, 360]`.
- **Integration / manual:** launch a CC+IC campaign with cadence=15min and a dummy 1-lead sheet. Confirm in the log that an auto-check fires ~15min after monitoring starts. Close laptop, reopen — confirm the wake hook fires a check immediately.
