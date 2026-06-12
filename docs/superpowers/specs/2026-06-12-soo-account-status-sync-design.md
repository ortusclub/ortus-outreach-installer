# SoO Account-Status Sync — Design

**Date:** 2026-06-12
**Status:** Approved design → ready for plan
**Origin:** Task 3 ("SoO account-status sheet sync") deferred from the 2026-06-11 primary-side
automation brainstorm. Brought back as its own spec, as promised.

---

## 1. Summary

The app writes account status back to the team-wide **State of Operations (SoO)** board —
the "LinkedIn Accounts" tab — so the board reflects reality without anyone editing the Google
Sheet by hand. Two one-way, best-effort writes:

1. **Auto-flip on use** — when a GoLogin account performs its first real send in a run, mark
   the credit it consumes as **In Use** and stamp **who's using it** (the operator's login email).
2. **Logout → Needs Login** — when an account is detected genuinely logged out, set its
   **Needs Login** cell to **Y** so the LinkedIn team knows to re-log it.

**Reset model:** the app only ever *sets* status. It never reverts. The team resets the board to
"Available" manually at the start of each week. There is **no editor UI** and **no auto-revert**.

This is purely a **write-back** feature. The app already *reads* the SoO (badges, picker,
assignee filter); nothing about reading changes.

---

## 2. Goals / Non-Goals

**Goals**
- Flip the correct credit column to "In Use" + stamp the operator email, per campaign mode.
- Only ever flip a cell that is currently "Available" (never clobber a colleague, an "NA", a
  "Used", or the manually-maintained `(NN)` counts).
- Flag accounts that are genuinely logged out as "Needs Login = Y" on the board.
- Never let a SoO write affect outreach — every write is fire-and-forget and isolated.

**Non-Goals (explicitly out of scope)**
- Manual editing of the SoO from the app (no status/assignee editor UI).
- Auto-reverting "In Use" back to "Available" (weekly manual reset by the team instead).
- Managing the `(NN)` credit-count suffix in the User columns.
- Writing for DM-to-connections modes or read-only modes (see the mapping table).
- Changing the existing v2.84 lead-sheet "Needs Login" write (it stays as-is; see §6).

---

## 3. The SoO board (target sheet)

- Sheet ID: `SOO_SHEET_ID` (`1t49JaZppDZZNIUuOv2QQw7j1MCZC8vMMy1uZe_AkLwI`), tab gid
  `SOO_SHEET_GID` (`992076199`) — the "LinkedIn Accounts" tab the app already reads via
  `fetchSoOData()`. Shared "anyone with the link can edit," written by the central Apps Script
  (running as Antonio).
- Keyed by **Email** (column A). Section-label rows (no `@`) are skipped.
- Relevant columns (all located **by header name**, never by position):

  | Credit column (dropdown) | Paired User column |
  |---|---|
  | `Sales Nav (OP Credits)` | `Sales Nav User` |
  | `Linkedin (OP Credits)` | `Linkedin OP User` |
  | `Inmail Credits` | `Inmail User` |
  | `CC (Credits)` | `CC User` |

  Plus a standalone **`Needs Login`** column (values `Y` / blank).

- Credit dropdown states: **Available** (green), **In Use** (orange), **Used** (yellow),
  **NA** (red). We only ever write the literal string **`In Use`**, and only into a cell that
  currently reads exactly **`Available`** (case-insensitive, trimmed).

---

## 4. Mode → column mapping

The flip targets the credit the campaign actually consumes. Account row is matched by
**Email = the GoLogin profile name** (team convention: a pool account's GoLogin profile is named
with its SoO email; an exact case-insensitive match is required, and a non-match simply writes
nothing).

| Mode (`value`) | Display | Flip → "In Use" |
|---|---|---|
| `connect_only` | Connect Only | **CC (Credits)** → CC User |
| `connect_and_introduce` | Connect + Introduce Back (CC+IC) | **CC (Credits)** → CC User |
| `connect_and_message` | Connect + DM (CC+DM) | **CC (Credits)** → CC User |
| `inmail_only` | InMail Only | **Inmail Credits** → Inmail User |
| `open_profile_only` | Message Campaign | **the channel that actually sent** (see §4.1) |
| `introduce_back` | Introduction Campaign | *no write* |
| `message_only` | Direct Messages | *no write* |
| `check_status` | Check Status | *no write* |
| `sales_nav_scrape` | Sales Nav Scrape | *no write* |
| `check_dms` | Check DMs | *no write* |
| `post_amplification` | Post Amplification | *no write* |

### 4.1 Message Campaign channel resolution

`open_profile_only` can deliver via Sales Nav or LinkedIn (`opChannel`, default `sn_first`, with
an InMail fallback). The flip targets **whichever channel actually delivered the send**:

- Sales Nav send → `Sales Nav (OP Credits)` / `Sales Nav User`.
- LinkedIn send → `Linkedin (OP Credits)` / `Linkedin OP User`.
- InMail-fallback send → `Inmail Credits` / `Inmail User`.

**Plan research item:** confirm the open-profile send result already reports which channel it
used. If it does, read it from the send outcome. If it does **not**, fall back to the configured
primary channel (`sn_*` → Sales Nav, `li_*` → Linkedin) — **without modifying the off-limits
`src/linkedin/outreach.js` / `src/linkedin/actions.js`.** Document whichever path the plan takes.

---

## 5. Write rules (auto-flip)

1. **When:** on an account's **first successful send** in a run — not at campaign start. Selected
   accounts that never actually send stay "Available."
2. **Once per account per run:** a per-run `Set` of already-flipped profile names guards against
   repeat writes (mirrors the existing `_needsLoginAccounts` dedup `Set`).
3. **Guard (server-side, atomic):** the write only lands if the target credit cell currently reads
   exactly `Available`. The check-then-set happens **inside the Apps Script under a `LockService`
   lock**, so two operators starting accounts at the same time cannot race. If the cell is not
   `Available` (it's `NA`, `Used`, or already `In Use`), the write is a **no-op** and the existing
   value + User stamp + `(NN)` count are left untouched.
4. **Value written:** credit cell ← `In Use`; paired User cell ← the operator's login email
   (`campaign.createdBy`). The User cell is only written in the same operation that flips the
   credit cell (so we never overwrite a colleague's stamp on an already-In-Use account).
5. **Best-effort:** wrapped in try/catch, logged with a campaign-log line
   (e.g. `  ⚑ SoO: marked <email> CC In Use (<operator>)` / `  · SoO: <email> CC not Available — skipped`).
   A failure never throws into the campaign loop.

---

## 6. Logout → Needs Login (board)

- **Trigger:** the existing **definitive** logout path only — `checkProfileHealth()` /
  launch-time `sessionExpired` detection (redirect to `/login`, `/uas/login`, `/checkpoint`, or a
  login form). This is where `setAccountNeedsLogin(pName, true)` is already called when a profile
  is parked with `reason: 'session_expired'`. It is **NOT** triggered by the
  `consecutive_skips` (5-fails) park, which can be a rate-limit rather than a logout.
- **Write:** set the account's SoO-board `Needs Login` cell to `Y` (row matched by Email = pName).
- **No auto-clear:** the app only ever sets `Y`. The LinkedIn team clears it by hand after they
  confirm the re-login. (Contrast: the lead-sheet flag self-clears; the board flag does not.)
- **Keep the existing behavior:** the v2.84 lead-sheet "Needs Login" write (which flags the lead
  rows that account handled, keyed by LinkedIn URL) is **left exactly as-is**. The new board write
  is **added alongside** it — two independent signals. The misleading "flag every SoO row" comment
  on the existing call site is corrected to describe what it actually does (lead rows).

---

## 7. Architecture

### 7.1 New Apps Script action — `setSoO` (`google-apps-script.js`)

```
action: 'setSoO'
data: {
  sooSheetId,            // SOO_SHEET_ID
  sooGid,                // SOO_SHEET_GID — resolve tab by gid (reuse handleGetSoO's lookup)
  email,                 // account email (= GoLogin profile name), matched against col "Email"
  fields: {              // header-name → value
    "CC (Credits)": "In Use",
    "CC User": "jane@ortus.solutions"
  },
  guardAvailableFor: ["CC (Credits)"]   // headers that may ONLY be written if current == "Available"
}
```

Behavior:
- Acquire a `LockService.getScriptLock()` (wait ~10s) around the read-then-write.
- Resolve the tab by gid (same loop `handleGetSoO` uses); find the data row whose `Email` cell
  matches `email` (case-insensitive, trimmed). No match → `{ success:true, matched:false }`.
- For each `fields` entry: find the column by exact header name. If the header is in
  `guardAvailableFor`, read the current cell first and **skip** unless it equals `Available`
  (case-insensitive, trimmed). Otherwise set the value.
- Return `{ success:true, matched:true, written:[...], skipped:[...] }`.
- Mirrors the existing header-name-targeted write style used for the `Needs Login` special case in
  `writeFields`. (Requires Antonio to redeploy the central Apps Script — same as any script change.)

### 7.2 New helper — `src/soo-writer.js`

Mirrors `src/soo.js` (shared URL, timeout, redirect-manual handling, `.code` errors). Exposes:

- `flipAccountInUse({ email, creditHeader, userHeader, operatorEmail })` → POSTs `setSoO` with the
  credit + user fields and `guardAvailableFor:[creditHeader]`.
- `markAccountNeedsLogin({ email })` → POSTs `setSoO` with `{ "Needs Login": "Y" }` (no guard).

Both resolve to a small result object and **never throw to the caller** (internal try/catch →
return `{ ok:false, error }`). Honour the kill-switch (§8).

### 7.3 Hook points (`src/campaign.js`)

- **Auto-flip:** at the point a profile records its **first successful send** this run, resolve the
  credit/user headers from the campaign mode (+ §4.1 channel for `open_profile_only`), then call
  `flipAccountInUse(...)` with `operatorEmail = campaign.createdBy`. Guarded by a per-run
  `Set<profileName>` so it fires once per account.
- **Needs Login:** in the existing `session_expired` park branch (right next to the existing
  `setAccountNeedsLogin(pName, true)` call), additionally call `markAccountNeedsLogin({ email: pName })`.

No new scheduler, no new route. Both calls are awaited inside an isolated try/catch and cannot
break the loop.

---

## 8. Kill-switch

Write-back is **on by default**. A single hidden config flag (env var
`ORTUS_SOO_WRITEBACK` — any value other than `"off"`/`"0"`/`"false"` keeps it on) lets Antonio
disable it fast if it ever misbehaves on the shared board. No per-campaign UI toggle. When off,
`flipAccountInUse` / `markAccountNeedsLogin` short-circuit to a no-op (and log once per run that
write-back is disabled).

---

## 9. Failure handling & isolation

- Every write is best-effort: try/catch in the helper, try/catch at the call site, logged, never
  rethrown. Outreach proceeds regardless of SoO reachability or a 503 from the Apps Script.
- `src/linkedin/outreach.js` and `src/linkedin/actions.js` are **not modified**.
- A non-matching email (profile not named as a pool email) is a silent no-op — expected for any
  account that isn't on the board.
- Concurrency across operators is handled by the `LockService` lock + the Available-only guard:
  the worst case under a race is one operator's flip landing and the other's being correctly
  skipped (cell no longer Available).

---

## 10. Testing

`node --test`, pure-helper unit tests preferred (matches repo convention). New tests:

- **Mode→column mapping** (`tests/soo-mode-column-map.test.js`): a pure
  `resolveSoOTarget(mode, { opChannel, sentChannel })` returns the right
  `{ creditHeader, userHeader }` for every mode, and `null` for the no-write modes; `sn_first`
  with an actual LinkedIn send resolves to Linkedin, etc.
- **Per-run dedup** (`tests/soo-flip-once.test.js`): the already-flipped `Set` makes a second
  first-send for the same account a no-op.
- **Payload shape** (`tests/soo-writer-payload.test.js`): `flipAccountInUse` /
  `markAccountNeedsLogin` build the correct `setSoO` body (fields + `guardAvailableFor`), and
  short-circuit to a no-op when the kill-switch is off (no fetch attempted).
- **Apps Script guard logic** is verified by extracting the pure decision
  (`shouldWriteCell(currentValue, header, guardHeaders)`) into a testable helper where practical;
  the live `LockService`/`SpreadsheetApp` path is verified by manual smoke test (run a small
  campaign, watch one account flip from Available → In Use with the operator email, and confirm an
  already-In-Use / NA cell is left untouched).

Target: full suite stays green; no change to existing read-path behavior.

---

## 11. Open implementation questions for the plan

1. **§4.1** — does the open-profile send outcome already report the delivered channel? If not, use
   the configured primary channel as the fallback (documented), no off-limits edits.
2. Confirm the exact campaign-loop site that marks a profile's **first successful send** (so the
   flip fires once, after a genuine send, not on a skip/park).
3. Confirm `campaign.createdBy` is populated for every entry path that starts a run (live start,
   queue run-next, scheduled monitoring) — fall back to blank User stamp if ever absent (still
   flip the credit cell).
