# Code Review — How the app determines "who has connected to whom"

**Scope:** Read-only trace of the connection-detection pipeline — the bulk-check,
the "Recent Connections" sheet tab, and how detection differs across
**CC+IC** (`connect_and_introduce`), **CC+DM** (`connect_and_message`), and
**CS** (`check_status`) modes.
**Date:** 2026-05-28 · **Branch:** `connection-check-review` · No code changed.

---

## TL;DR

1. **There is exactly one source of truth for "is this lead connected":** a live
   Voyager fetch of the account's *recent connections* (`getRecentConnections`),
   matched in-memory against the sheet rows by `computeBulkCheckUpdates`.
2. **The "Recent Connections" sheet tab is a WRITE-ONLY audit sidecar.** Despite
   being described internally as "the Bible for matching," **no code path reads it
   back.** Matching never falls back to the tab — it matches against the live
   `conns` array only. (See [Finding A](#finding-a--the-recent-connections-tab-is-not-a-matching-fallback).)
3. **The real fallbacks that exist** are: (a) a 3-key match cascade
   slug → memberId → name; (b) a 3-strategy Voyager response parser; and (c) a
   bulk → per-lead navigation fallback that only `check_status` mode uses.
4. **Mode differences are almost entirely in what happens AFTER a match**, not in
   how the match is computed. CC+IC fires an intro DM, CC+DM fires a plain DM, CS
   just stamps the sheet. The matching core is identical for all three.

---

## 1. The single source of truth — live Voyager fetch

**`src/linkedin/helpers.js:128` `getRecentConnections(page, sinceMs=0)`**

- Runs `fetch()` *inside the page context* so LinkedIn's `JSESSIONID` cookie is
  present as the CSRF token (`helpers.js:132-141`). No cookie → returns
  `{ error: 'no-csrf' }`.
- Probes three Voyager endpoints in priority order and settles on the first that
  returns JSON (`helpers.js:155-184`):
  1. `/voyager/api/relationships/dash/connections`
  2. `/voyager/api/relationships/connections`
  3. `/voyager/api/relationships/connectionsV2`
  — all with `q=search&sortType=RECENTLY_ADDED`.
- **Hard cap: 80 most-recent connections** (`PAGE_SIZE=40`, `MAX_PAGES=2`,
  `helpers.js:143-148`). This cap is the single most consequential design
  constraint in the whole pipeline — see [Finding B](#finding-b--the-80-connection-window).
- Three parse strategies, tried in order until one yields rows
  (`helpers.js:244-318`):
  - **A** — direct `elements[]` array (older endpoints).
  - **B** — normalized `*elements[]` URN refs resolved against `included`.
  - **C** — fallback scan of `included` for any profile-shaped URN. Comment at
    `helpers.js:290-297` acknowledges this can theoretically pull "people you may
    know" suggestions, but the later URN/publicId match against the sheet filters
    them out.
- Each connection is normalized to `{ urn, publicId, firstName, lastName,
  memberNumber, connectedAt }`.
- **Failure is a sentinel, not an exception:** returns an empty array with an
  `.error` property attached (`helpers.js:333-339`) so callers can surface the
  *reason* (`no-csrf`, `http-429`, `empty-after-3-strategies`, etc.) rather than
  a bare "nothing found."

---

## 2. The matching engine — `computeBulkCheckUpdates`

**`src/linkedin/bulk-check-connections.js:54`** — pure function (unit-testable, no
Puppeteer). Given `(rows, conns, linkedinColumn, stillPendingLabel, opts)` it
returns `{ updates, connectedUrls, diag }`.

### 2a. Match keys (the real "fallback" cascade)

It builds three lookup sets from the live `conns` (`bulk-check-connections.js:78-87`):

| Set | Built from | Sheet side compared against |
|-----|-----------|-----------------------------|
| `connectedSlugs` | `c.publicId` (the `/in/<slug>`) | `publicIdFromUrl(url)` |
| `connectedMemberIds` | `ACoAA…`/`ACwAA…` extracted from `c.urn`/`c.publicId` | `LinkedIn URN` col, else extracted from URL |
| `connectedNames` | `firstName + lastName` (lowercased) | `First Name` + `Last Name` cols |

A row is a match if **any** of the three hits (`bulk-check-connections.js:173-175`).
Slug is most precise; member-ID covers URN-encoded `/in/ACwAA…` URLs; name is the
last-resort net.

### 2b. Sender scoping (v2.62 — the cross-account guard)

- The active-sender set = distinct `Sender` column values
  (`bulk-check-connections.js:68-72`).
- Scoping is active only when the caller passes a non-empty `profileName` **and**
  the sheet has a Sender column (`:74`). Empty → legacy single-account behavior.
- **Guard 1 (caller-level):** if scoping is on and the *calling account* isn't a
  campaign sender, return entirely empty — don't touch any row
  (`:111-127`).
- **Guard 2 (row-level):** `rowSenderMismatch` — the lead is in *this* account's
  network but the row is assigned to a *different* sender (`:167-171`). On a
  match it writes only an informational `Stage = "Already connected to <name>"`,
  does **not** stamp `Connected`, does **not** push to `connectedUrls`, does
  **not** fire this account's DM/intro (`:240-249`). It also won't let a foreign
  account downgrade the row to Still Pending (`:311`).
- Operator's stated rule, verbatim in the source: *"if Antonio isn't running the
  campaign, who cares?"* (`:62-63`).

### 2c. Per-row decision flow (in order)

For each row (`bulk-check-connections.js:129`):

1. No URL → skip (`:131-132`).
2. `cs === 'Connection Declined'` → skip (`:144`).
3. `cs` starts with `Unverified — manual review` → skip — sticky downgrade written
   by the reverify path; only the operator clears it (`:149-152`).
4. Compute `isMatch` and `wasInvited`
   (`requestStatus === 'Connection Request Sent'`, `:186-191`).
5. **If matched (`:193`):**
   - Already introduced (`Introduction Status` = `Introduction Made` /
     `Introduction Already Made`, or in the in-memory `introducedInRun` set) → skip
     (`:207-220`).
   - Per-URL compose-failure cap ≥ 3 → skip (`:226-229`).
   - Cross-sender mismatch → informational Stage only (`:240-249`).
   - Otherwise push to `connectedUrls` (always, even if `cc` already stamped — this
     is what lets `Skipped — Stop pressed` / `browser closed` / `Failed` leads
     recover on the next sweep, `:251-258`).
   - Stamp the sheet **only if not already stamped** (`:263`):
     - `wasInvited` → `cc='Connected'`, `stage='Connected'`,
       `connectedAlready='Yes'`, `checkStatus='Connected'` (`:270-282`).
     - `!wasInvited` (pre-existing 1st-degree, no prior bot outreach) →
       `sender=<profileName>`, `stage='Already connected'`,
       `cc='Already connected'`, `checkStatus='Already connected'` (`:283-300`).
6. **If not matched but `wasInvited`:** stamp `Still Pending (<timestamp>)` — but
   only after passing the "never downgrade" guards (`:305-331`):
   - skip if `rowSenderMismatch` (`:311`),
   - skip if `cs` is already `Connected`/`Already connected` (`:320`) — see
     [Finding B](#finding-b--the-80-connection-window),
   - skip if already introduced (`:321-324`).

### 2d. Dual-column writes (schema-migration bridge)

Every stamp writes **both** `cc` and `checkStatus` (`:281`, `:298`, `:329-330`).
On the v2.14 schema both map to the same `Connection Accepted Status` column (a
no-op double-write); on older v2.13 sheets they're separate `Connected Status` /
`Check Status` columns, so this fills both. The accepted-status *read* likewise
checks five header variants for back-compat (`:138-143`).

---

## 3. The "Recent Connections" sheet tab — what it actually is

**Write path:** `bulkCheckConnections` maps the fetched `conns` into sidecar rows
and calls `writeRecentConnectionsTab` (`bulk-check-connections.js:436-451`) →
`sheets-writer.js:297` → Apps Script `handleWriteRecentConnections`
(`google-apps-script.js:1399`).

- One shared tab named **`Recent Connections`**, columns
  `Account · First Name · Last Name · Public ID · LinkedIn URN · Member ID ·
  Connected At · Fetched At` (`google-apps-script.js:1397`).
- Each sweep refreshes only the calling account's rows and **drops any row whose
  `Account` isn't in the campaign's active-sender set** (`google-apps-script.js:1434-1448`)
  — the tab is scoped to campaign senders, mirroring the in-memory sender scoping.
- It is a **best-effort, non-fatal audit dump** — a write failure is caught and
  logged but doesn't break the bulk-check (`bulk-check-connections.js:449-451`).

### Finding A — the "Recent Connections" tab is NOT a matching fallback

The task framing ("the bulk-check / Recent Connections sheet-tab fallback")
implies the tab is consulted when the live fetch is unavailable. **It is not.**
A full grep of `google-apps-script.js`, `src/`, `server.js`, and
`public/js/app.js` shows the tab is referenced by exactly one handler —
`handleWriteRecentConnections` — and is **never read back** as a matching source.
Matching always runs against the live in-memory `conns` array
(`computeBulkCheckUpdates(rows, conns, …)`); if the Voyager fetch returns zero
rows, `bulkCheckConnections` returns early with the error and **no matching
happens at all** (`bulk-check-connections.js:400-406`) — it does not consult the
previously-written tab.

**Implication:** the tab is purely an operator-facing audit log. The phrase "the
tab is the Bible for matching" in the source comment (`:421`) is aspirational —
the tab *records* what was matched against, but the matching itself is in-memory
and ephemeral. If that read-back fallback is expected to exist, it's a gap.

### Finding B — the 80-connection window

Because `getRecentConnections` caps at the 80 most-recent connections
(`helpers.js:148`), an accepted invite that is older than the 80 newest
connections **silently falls off the Voyager list**. The "never downgrade a known
connection" guard at `bulk-check-connections.js:308-320` exists precisely to stop
this from wiping the audit trail (operator screenshot 2026-05-16: an intro'd lead
re-stamped "Still Pending"). This guard is load-bearing — it's the only thing
preventing the 80-cap from corrupting older rows on busy accounts.

---

## 4. When does the bulk-check run? (trigger paths)

| Trigger | Location | Cadence / gate |
|---|---|---|
| In-campaign piggyback after a `connection_sent` | `campaign.js:2625-2693` | every 5 min per (sheet,profile) — `IN_CAMPAIGN_BULK_CHECK_INTERVAL_MS`; **CC+IC & CC+DM only** |
| Idle bulk-check (reopen a parked profile) | `campaign.js:1954-2025`, gated by `shouldFireIdleBulkCheck` (`:150-158`) | 7 gates; **CC+IC & CC+DM only** (`:153`) |
| Pre-flight check status | `campaign.js:1863-1900` | `preflightCheckStatus` toggle on `message_only`/`introduce_back` |
| Standalone Check Status sweep | `campaign.js:1866-1899` | `mode === 'check_status'` |
| Manual "bulk check now" button | `server.js:1360-1419` (`/api/bulk-check-now`) | operator-triggered |
| Post-campaign scheduled sweep | `src/post-campaign-bulk-check.js:188` | scheduled, default OFF |

All share a 6 h cooldown file (`bulk-check-cooldown.json`,
`campaign.js:72-73`) except the in-campaign path, which uses the tighter 5-min
interval, and explicit operator actions, which bypass cooldown then refresh it.

---

## 5. How detection differs across CC+IC, CC+DM, and CS

**The match computation is identical** — all three call the same
`bulkCheckConnections` → `computeBulkCheckUpdates`. The differences are entirely
in (a) which triggers fire and (b) what happens to `connectedUrls` afterward.

| | **CC+IC** (`connect_and_introduce`) | **CC+DM** (`connect_and_message`) | **CS** (`check_status`) |
|---|---|---|---|
| Phase-1 per-lead step | Send connect request (`force_connect`, `campaign.js:371`) | Send connect request (`force_connect`) | None — read-only |
| In-campaign + idle bulk-check | **Yes** (`:1961`, `:153`) | **Yes** (v2.62, `:1968`, `:153`) | N/A (bulk *is* the whole run) |
| Post-match action on `connectedUrls` | `runAutoIntros` — 3-way intro DM to the configured Primary Person (`:1985-1996`, `:2664-2675`) | `runAutoDms` — plain DM with `ccDmBody` (`:1997-2008`, `:2676-2687`) | none — just stamps `Connected` / `Still Pending` |
| Gate on firing phase-2 | `primaryName` **and** `primaryIntroBody` non-empty (`:1961-1964`) | `ccDmBody` non-empty (`:1968-1970`) | — |
| Stamp written on match | `Connected` + Stage `Connected`; intro pass then writes `Introduction Status` | `Connected` + Stage `Connected`; DM pass writes `DM Status` | `Connected` / `Already connected` + `checkStatus` |
| Bulk → per-lead fallback | No | No | **Yes** — if Voyager fetch errors, falls through to per-lead navigation (`campaign.js:1857-1894`) |
| Daily limit | respects `dailyLimit` (connects are rate-limited) | respects `dailyLimit` | bypassed — `NO_DAILY_LIMIT` (`:2075`) |

### Key per-mode notes

- **CC+IC and CC+DM are structurally twins.** The CC+DM idle/in-campaign hooks
  (`:1968`, `:2643`) were added in v2.62 explicitly to mirror CC+IC's existing
  shape; the only divergence is `runAutoDms` vs `runAutoIntros` and the gate
  template field.
- **CS is the only mode with a true bulk→per-lead fallback.** When the bulk
  Voyager fetch succeeds, the per-lead loop is skipped entirely and the profile is
  closed (`campaign.js:1895-1899`). When it *fails*, the run falls through to the
  legacy per-lead navigation path (`:1893-1894`) — "Sam's approach failed → ours."
- **The per-lead path uses a different signal than bulk.** Per-lead detection
  (`src/linkedin/outreach.js:379-425`) reads the **degree badge** via Voyager
  `networkinfo` (`DISTANCE_1` → `status_accepted`) with a DOM `1st`-badge
  fallback — it does *not* use the recent-connections list. So CS has two
  independent connection signals: bulk (recent-connections list) and per-lead
  (degree badge).

---

## 6. The reverify-and-downgrade safety net (CC+IC & CC+DM)

Because the recent-connections match can false-positive (Strategy C suggestions,
name collisions, stale URNs), `runAutoIntros`/`runAutoDms` re-check each lead
before sending:

- After a compose-textbox failure, `_reverifyAndDowngrade`
  (`auto-intro.js:68`, `auto-dm.js:54`) navigates to the profile and calls
  `getConnectionStatus(page)`. If the lead is provably *not* 1st-degree, it stamps
  `Connection Accepted Status = 'Unverified — manual review (<date>)'`
  (`auto-intro.js:89-96`).
- That `Unverified —` prefix is the **sticky downgrade** that
  `computeBulkCheckUpdates` honors at `bulk-check-connections.js:149-152` — once
  written, subsequent sweeps won't re-stamp `Connected` even if Voyager keeps
  returning the URN. Only the operator clears the cell.
- The `composeAttempts` map caps this at 3 retries per URL
  (`bulk-check-connections.js:226-229`) so one false positive can't cause a retry
  storm.

CS has no equivalent reverify — it trusts the bulk match (or the per-lead degree
badge on fallback) and stamps directly.

---

## 7. Observations & risks

1. **[Finding A] No tab read-back.** If the product intent is for the Recent
   Connections tab to serve as a matching fallback when Voyager is unavailable,
   that fallback does not exist in code. Today, a failed fetch means a no-op sweep.
2. **[Finding B] The 80-connection cap is a silent ceiling.** On a high-volume
   account, acceptances older than the 80 newest connections will never be matched
   by a fresh sweep — they're only ever caught if they were matched while still in
   the window. The "never downgrade" guard protects already-stamped rows but does
   **not** help a row that was *never* stamped before falling out of the window
   (e.g. acceptance happened during a multi-day outage). Such a row stays
   `Still Pending` forever. Worth confirming this matches operator expectations.
3. **Strategy C false-positive surface.** The `included`-scan fallback
   (`helpers.js:290-318`) can include non-connections; the URN/slug/name match is
   the only filter. Name-only matches (`connectedNames`) are the weakest link — a
   common name shared between a real connection and a pending lead could
   cross-stamp. The reverify net (CC+IC/CC+DM) catches this on send; CS does not.
4. **CS per-lead fallback uses a different code path** (`outreach.js`, degree
   badge) than the bulk path (recent-connections list). The two can disagree
   (e.g. a lead who's 1st-degree but outside the 80-window: per-lead says
   connected, bulk says pending). Only CS exercises both; CC+IC/CC+DM rely solely
   on the bulk list + reverify.

---

## Files traced

- `src/linkedin/helpers.js:128-380` — `getRecentConnections` (Voyager fetch)
- `src/linkedin/bulk-check-connections.js` — `computeBulkCheckUpdates` + `bulkCheckConnections`
- `src/campaign.js` — triggers (`:1855-1900`, `:1954-2025`, `:2625-2693`), mode routing (`:366-402`)
- `src/linkedin/auto-intro.js` / `src/linkedin/auto-dm.js` — phase-2 dispatch + reverify
- `src/linkedin/outreach.js:379-543` — per-lead degree-badge check (CS fallback)
- `src/sheets-writer.js:287-316` — `writeRecentConnectionsTab`
- `google-apps-script.js:1383-1478` — `handleWriteRecentConnections` (tab is write-only)
