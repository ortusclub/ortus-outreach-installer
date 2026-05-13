# Monitoring Phase — Design Spec

**Status:** Draft, pending operator review
**Date:** 2026-05-13
**Author:** Antonio (with Claude)
**Scope:** Connect + Introduce Back mode — post-sending lifecycle, unified logging, daily-limit copy fix
**Sketch:** `public/sketches/monitoring-phase-sketch.html`
**Source bugs:** UAT feedback from boss after PR #17 first test run

---

## 1. Goal

Replace the current "Phase 1 ends → Phase 2 runs as invisible background scheduled job" lifecycle for `connect_and_introduce` campaigns with a single continuous lifecycle: `running → monitoring → done`. The Monitoring state lasts a fixed 7 days, surfaces a dedicated card in the dashboard's Schedules lane, keeps the same log stream alive across both phases, and survives app restarts.

In parallel, fix two narrower bugs uncovered in the same UAT run:
- **B1** No bulk-check fires at end-of-sending (operator expects an immediate check the moment the last invite goes out).
- **B3** End-of-run reason says "Reached daily limit (N)" but the value comes from the UI's "Campaign limit per account" field — the word "daily" misleads the operator into thinking LinkedIn or the system imposed it.

---

## 2. User stories

- **S1.** Operator launches a Connect + Introduce Back campaign with 7 leads × 2 accounts. The last connection request goes out at 01:31. They see one extra `📡 End-of-list bulk check` in the same log window within seconds, not 6 hours later.
- **S2.** Once sending finishes, the campaign moves out of the "active sending" UI into a card in the Schedules lane labeled `BULK CONNECTION CHECK + INTRODUCE — Monitoring`. The card shows the next scheduled check time and ends-in countdown.
- **S3.** Operator clicks "Show details" on the Schedules card. They see each participating account with last-check timestamp, three counts (pending / connected & introduced / timed out), and the same continuous log stream that was live during sending — now appended with the 6-hourly check results.
- **S4.** Operator clicks `⚡ Check now`. Within seconds an immediate bulk-check fires across all participating accounts. The 6-hour schedule continues unaffected.
- **S5.** Operator clicks `✕ Stop monitoring`. The 7-day window ends immediately, any still-pending leads get stamped `Closed - Not Connected` in the sheet, the campaign transitions to `done`.
- **S6.** Operator quits the app at hour 4 of the 7-day window. They reopen at hour 10. The Monitoring card is back in Schedules, log history is intact, the next-check time is correctly recomputed (next 6h slot from the original end-of-sending timestamp), and the schedule re-arms.
- **S7.** At T+7 days the campaign auto-transitions to `done`, the Schedules card disappears, and any still-pending leads are stamped `Closed - Not Connected`.
- **S8.** Operator sees a campaign card that previously said "Reached daily limit (3)" now says "Reached campaign limit (3)". When the operator launches a campaign, the launch summary log explicitly echoes the configured limit so a forgotten preset value is visible at launch time.

---

## 3. State machine

```
                   ┌─────────────────────────────────────────────┐
                   │           connect_and_introduce             │
                   │                                             │
   [launch] ─────► running ──► (sending phase complete) ─────► monitoring
                      │                                          │
                      │                                          ├── (T+7d elapsed)        ──► done
                      │                                          ├── (operator Stop)       ──► done
                      │                                          └── (manual Check now)    ──► (no state change)
                      │
                      └── (operator Stop) ─────────────────────────────────────────────────► done
```

**Transitions:**
- `running → monitoring`: fires when the worker pool exhausts the lead queue for ALL participating accounts AND mode is `connect_and_introduce`. Other modes go straight `running → done` as today.
- `monitoring → done`: fires when `now >= monitoringUntil` OR operator clicks Stop monitoring.

**Invariants:**
- A campaign is in exactly one state at any time.
- `monitoring` only exists for `connect_and_introduce`. All other modes preserve current behavior.
- While in `monitoring`, the campaign holds NO browser semaphore reservations between checks (browsers are opened on-demand by the scheduled bulk-check, same as today's Phase 2).

---

## 4. End-of-list bulk-check (B1)

**Trigger.** At the moment the worker pool's `pickNextProfile()` returns null AND every participating account has had at least one `connection_sent` action AND there are no in-flight requests, fire one extra bulk-check pass.

**Behavior.** For each account that participated in the campaign:
1. Acquire a browser semaphore slot.
2. Launch the profile.
3. Call `bulkCheckConnections(page, sheetUrl, linkedinColumn, pName, { suppressAcceptedStamp: true })`.
4. Pipe any `connectedUrls` through `runAutoIntros` with the campaign's primary name + intro body.
5. Close the profile.
6. Release the slot.

Sequential per account (respects the existing browserSemaphore caps). Logs interleave into the live campaign log.

**Independence.** This trigger is purely additive:
- Does NOT reset the in-batch 5-min cooldown.
- Does NOT shift the 6h × 7-day post-campaign schedule (that schedule arms after this end-of-list pass and uses end-of-sending as its t=0).
- Skipped if the campaign already entered `monitoring` (idempotency guard).

**Edge cases:**
- Zero leads ever processed (sheet empty, all skipped): skip the end-of-list pass, go straight `running → monitoring`.
- A participating account ejected/parked before end-of-list: skip that account, continue with the rest.
- All participating accounts ejected: still transition to `monitoring`; the scheduler will retry on the next 6h tick.

---

## 5. Monitoring state — data shape

Two new persisted fields on the campaign object (already serialized to disk; just adds keys):

```js
{
  // ... existing fields ...
  state: 'monitoring',              // was 'running' | 'done'; now adds 'monitoring'
  sendingEndedAt: '2026-05-13T01:31:45.000Z',   // ISO; set when running → monitoring
  monitoringUntil: '2026-05-20T01:31:45.000Z',  // ISO; = sendingEndedAt + 7 days
  nextCheckAt: '2026-05-13T07:31:45.000Z',      // ISO; recomputed after each check
  participatingProfileIds: ['p-marife', 'p-ayush'],  // accounts to bulk-check
}
```

**Computation rules:**
- `sendingEndedAt`: set once, at the `running → monitoring` transition. Never updated.
- `monitoringUntil`: `sendingEndedAt + 7 * 24 * 60 * 60 * 1000`. Set once, never updated.
- `nextCheckAt`: ceil((now - sendingEndedAt) / 6h) × 6h + sendingEndedAt. Recomputed after every check AND on app restart.
- `participatingProfileIds`: list of profile IDs that sent at least one `connection_sent` during Phase 1. Set once at the transition.

---

## 6. Dashboard UI

**Schedules lane card** (see sketch `public/sketches/monitoring-phase-sketch.html`).

**Collapsed state (default):**
```
┌───────────────────────────────────────────────────┐
│ BULK CONNECTION CHECK + INTRODUCE   [● MONITORING]│
│ Next check: today at 14:32 · ends in 6d 19h       │
│                                                   │
│ ▾ Show details                                    │
└───────────────────────────────────────────────────┘
```

**Expanded state (Show details clicked):**
- Header row (same as collapsed)
- Actions: `⚡ Check now`, `✕ Stop monitoring`
- Accounts list: each row `<email>   last check: HH:MM · Nm ago`
- Counts row: pending / connected & introduced / timed out (after 7d)
- Live log (scrollable, max ~200px height in the card; full-screen log view via the existing log-view button is fine)

**Badge color rules:**
- `> 24h remaining` → green border + text
- `≤ 24h remaining` → red border + text, label changes to `● ENDING SOON`

**Lane choice.** Schedules lane (operator chose A). Schedules ordering: Monitoring campaigns at the top, then existing cron-schedule entries beneath. Optional: a sub-divider with a "MONITORING" sub-label between the two groups (nice-to-have, not required for v1).

**Action semantics:**
- `⚡ Check now`: fires the same end-of-list bulk-check routine (Section 4) immediately. Does NOT reset `nextCheckAt`. Does NOT consume the 7-day window faster. Disabled (greyed) while a check is in flight.
- `✕ Stop monitoring`: opens a small confirm dialog: *"End monitoring now? N pending leads will be stamped Closed - Not Connected."* On confirm, transitions to `done`, writes stamps, removes card.

---

## 7. Unified log

**Mechanism.** The campaign object already owns an in-memory log array (`campaign.logs`). The current post-campaign-bulk-check.js scheduled job logs to its own console only. Change: every log line the scheduled job emits during a check pass also appends to `campaign.logs` for the originating campaign id.

**Persistence.** Logs are already persisted to disk per the existing campaign-state writer. Same writer covers Monitoring-phase appended lines — no new persistence work, the append goes through the same path.

**Log lines added in Monitoring phase:**
- `🛏 Monitoring started · next check at HH:MM` (once, at running → monitoring)
- `📡 End-of-list bulk check · all accounts` (once, at end of sending — Section 4)
- `📡 <account>: bulk check, N new accepted` (one per account per check pass)
- `🤝 <account> → <profile-slug>: Introduction Made` (one per intro DM)
- `🛏 Monitoring idle · next check at HH:MM` (one per check pass, after the pass completes)
- `🛏 Monitoring ended · N still-pending leads stamped Closed - Not Connected` (once, at stop)

**Log line cap.** Existing cap on `campaign.logs` (currently the ring-buffer behavior in `campaign.js`) applies unchanged. If the cap fills during a long Monitoring run, oldest lines drop first.

---

## 8. Restart resume

**Loader change.** At app start, after the existing campaign-state hydration:

```
for each campaign C in loaded state:
  if C.state === 'monitoring':
    if C.monitoringUntil <= now:
      transition(C, 'done')                       # window expired while app was off
      stampStillPendingLeads(C)                   # same logic as Stop monitoring
      continue
    C.nextCheckAt = recomputeNextCheckAt(C.sendingEndedAt, now)
    registerPostCampaignSchedule(C)               # same call site as today, just rehydrated
    appendLog(C, '🛏 Monitoring resumed · next check at HH:MM')
```

**`recomputeNextCheckAt`:** pure function. Given `sendingEndedAt` and `now`, returns the next 6h boundary ≥ now. Test target: pure-function unit test.

**Edge case: app crashes mid-check.** The check pass for that tick is lost; the next 6h tick still fires. Acceptable for v1 — we don't try to recover an in-flight check across crashes.

---

## 9. Daily-limit copy fix (B3)

**User-facing string changes** (scan and replace, scoped to operator-visible text only):

| Location | Before | After |
|---|---|---|
| `src/campaign.js:2195` | `Reached daily limit (N)` | `Reached campaign limit (N)` |
| Any error toast | `daily limit` | `campaign limit` |
| Any preset summary text | `daily limit` | `campaign limit per account` |

**No change** to the variable name `dailyLimit` in code, to keep the rename surgical. Variable name is internal; operator never sees it.

**New launch-summary line.** Append one line to the existing launch summary log (around `src/campaign.js:1014`):

```
Campaign limit per account: <N>   (configured in launch wizard / loaded from preset "<name>")
```

When the value came from a loaded preset, the preset name appears in parentheses. This surfaces a "forgotten preset value" before the campaign starts processing.

---

## 10. Out of scope

- **Multi-campaign collision.** If the operator launches a new campaign while a Monitoring one is using the same accounts, queue behavior is unchanged. Not addressing here.
- **Notification / push when a new lead lands during Monitoring.** Not adding.
- **Custom Stop-monitoring stamps.** The auto-stamp on Stop or T+7d is the literal string `Closed - Not Connected`. Not operator-configurable in v1.
- **Pause/Resume of Monitoring.** No pause primitive. Operator's options are Check now, Stop monitoring, or wait.
- **Calendar view of upcoming checks.** A simple "next check at HH:MM" inline label is enough; no separate calendar widget.
- **Multiple Monitoring campaigns merging into one card.** Each campaign gets its own card even if they share accounts.

---

## 11. Testing strategy

**Pure-function tests** (no Puppeteer / no Electron):
- `tests/monitoring-state-transitions.test.js` — `running → monitoring` only when mode is `connect_and_introduce` AND end-of-list AND ≥1 `connection_sent`; other modes go straight to `done`; idempotent transition (calling twice is a no-op).
- `tests/monitoring-time-math.test.js` — `monitoringUntil = sendingEndedAt + 7d` exactly; `recomputeNextCheckAt(sendingEndedAt, now)` returns the next 6h boundary ≥ now; works correctly across DST and across multi-day gaps.
- `tests/monitoring-resume.test.js` — given a serialized campaign with `state=monitoring` and various `monitoringUntil` / `now` values, the resume routine produces the right outcome (resume, expire-and-stamp, or no-op).
- `tests/end-of-list-detection.test.js` — `isEndOfList(workerState)` returns true exactly when all queues exhausted and no requests in flight.

**Integration tests** (touch real campaign state, mock browser):
- `tests/monitoring-log-append.test.js` — scheduled check pass appends to the campaign's log array, ring-buffer cap honored.
- `tests/stop-monitoring.test.js` — Stop transitions to `done`, stamps still-pending leads.

**Manual UAT (operator-driven, not automated):**
- Launch real campaign, observe end-of-list bulk-check fires within ~30s of last invite.
- Quit and reopen app during the 7-day window, confirm card reappears and next-check time is correct.
- Click Check now, observe immediate bulk-check.
- Click Stop monitoring, observe Closed - Not Connected stamps.
- Let the window run to T+7d (or fast-forward `monitoringUntil` for the test), confirm auto-close.

---

## 12. Acceptance criteria

- [ ] End-of-list bulk-check fires for ALL participating accounts before the campaign exits the sending phase.
- [ ] Campaign card appears in Schedules lane within 1 second of `running → monitoring`.
- [ ] Card shows accurate next-check countdown, accounts, counts, and live log.
- [ ] `⚡ Check now` fires an immediate bulk-check without changing the 6h schedule.
- [ ] `✕ Stop monitoring` confirm-dialog flow ends the window and stamps pending leads.
- [ ] Quitting and reopening the app during the 7-day window correctly re-arms the schedule.
- [ ] At T+7d the campaign auto-transitions to `done` and the Schedules card disappears.
- [ ] No user-facing string contains the word "daily" in reference to `dailyLimit` after this lands.
- [ ] Launch summary log echoes `Campaign limit per account: N` on every campaign start.
- [ ] All existing tests pass; new tests cover the additions above.
- [ ] No regression in `connect_only`, `check_status`, `message_only`, `introduce_back`, `inmail_only`, `open_profile_only` modes.

---

## 13. Open questions

None. All operator decisions captured in Sections 4–9. Implementation plan can be written against this spec without further input.
