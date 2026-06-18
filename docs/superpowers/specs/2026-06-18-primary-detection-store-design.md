# Primary Detection: Persistent Store + Deferrable Timing + Visible UI (#7 + #8) — Design

> Checks/verification model batch. Backlog #8 (persistent Primary status store) leads;
> backlog #7 (progressive/deferrable primary check) rides along, scoped to the primary step.
> Backlog: `docs/superpowers/backlog/2026-06-18-suggestions.md`.

**Date:** 2026-06-18
**Status:** Approved for planning
**Off-limits (do NOT touch):** `src/linkedin/outreach.js`, `src/linkedin/actions.js`.

## Problem

In Connect+Introduce-Back / intro modes, each sending account's connection to the configured
**primary** person is verified by reading the primary's connection degree (`readPrimaryDegree`
→ Voyager networkinfo, fallback DOM badge). Today that result lives **only in memory**
(`campaign._primaryConn`, `campaign.js:670`) and is **lost on every app restart**. Consequences:

1. **Re-verification waste + false flags.** Every restart re-reads every account's primary
   degree from scratch. Those re-reads are exactly what hit Voyager rate-limiting on encoded
   `/in/ACwAA…` URLs and produce false "No Primary" labels (the recurring identity pain).
2. **No pre-campaign knowledge.** When picking accounts, the operator can't see which accounts
   are *already* connected to the primary — even though the system has confirmed it before.
3. **Forced timing.** A recent change made the primary handshake a **blocking pre-flight** before
   the campaign loop. Some operators want it to run later (the way it worked previously), not
   gate the start.
4. **Subtle UI.** Primary status is a tiny `.prof-primary-tag` pill buried mid-row in the live
   view (`app.js:12612`). Operators want primary detection to be **prominent**.

## Decisions (locked, from brainstorming)

| Decision | Choice |
|---|---|
| Lead feature | **#8 persistent store** — remember per-account connection-to-primary across restarts/campaigns. |
| Scope of store | **Primary status only.** CC (connection-acceptance) already persists via the sheet's *Recent Connections* tab — untouched. |
| Trust model | **Trust stored `connected`** → skip the live read on future turns/runs (1st-degree effectively never reverts). Re-check only `pending`/`unverified`/unknown. **Fallback:** a live read of `unverified` (read failure / rate-limit) with a stored `connected` resolves to `connected` — never a false "No Primary." |
| Pre-campaign knowledge | The store is **read at pick-time** (before start). The picker shows each account's remembered primary status; it does **not** do live checks while picking. |
| #7 timing | An additive **"Primary check timing"** dropdown: **Immediately (at start)** = today's blocking pre-flight, **unchanged default**; **After connections complete** = defer the primary connect/check to the outreach→monitoring handoff (restores prior behavior). Timer/30-min and per-turn variants dropped. |
| Visibility | **Variant 3 — dedicated primary panel** in the running-campaign view, **plus** a store-sourced **primary row in the account-picker cards**. |
| Reference sketch | `public/sketches/primary-detection-variants.html` (real app CSS — the look the implementation must match). |

## Hard requirements

1. **Preserves existing behavior (additive only).** Default timing = Immediately (today's
   pre-flight). With no `data/primary-status.json` present, behavior is identical to today: the
   store starts empty, everything re-checks once, then is remembered. The tri-state
   `unverified ≠ pending` semantics (v2.102) are preserved. **No CC changes. No off-limits-file
   changes.** Nothing the operator currently relies on is removed.
2. **Real style, wired to real data.** UI reuses the real running-view row markup (`.vj-prof-row`,
   `.prof-primary-tag`) and real picker markup (`.profile-item`, `renderSoOBadges`), with new CSS
   in the app's own tokens (`--green`, amber `#d97706`, `--gray`, `--blue`, `--hairline`,
   `--card-bg`/`--card-border`, `--mono`) exactly as in the reference sketch. Every status is
   computed from the real store / `_primaryConn` state machine — **zero invented data**.
3. **Off-limits untouched.** The optional connect-to-primary uses `sendConnectionRequest` (in
   `actions.js`, off-limits) but is already invoked via `primary-connection.js` behind the
   `attemptConnect` flag. We change only the **orchestration/timing of when
   `checkAndConnectPrimary` is called** — never `actions.js`/`outreach.js`. No `git add -A`
   (never stage `data/monitoring-campaign.json`).

### Don't do
- No persisting/caching of CC acceptance (already handled by the sheet).
- No live primary checks during account selection (store reads only).
- No removal of the current pre-flight path — it stays as the default "Immediately" mode.
- No new scheduler/timer for #7 (the two modes reuse existing hooks).

## Data sources (grounded — verified in code)

- Primary degree read: `readPrimaryDegree(page, primaryUrl)` → `1st|2nd|3rd|unknown`
  (`src/linkedin/primary-connection.js:97`), mapped by `degreeToConnected` /
  `primaryConnState` to `connected|pending|unverified` (`primary-connection.js:46`).
- In-memory state today: `campaign._primaryConn` Map, profileId → state (`campaign.js:670`),
  seeded/updated at per-account turn (`campaign.js:2882`) and pre-flight handshake
  (`campaign.js:4085-4185`). Not persisted.
- Identity normalization for a stable `primaryKey`: reuse the existing member#/ACwAA/slug
  resolution path (`src/profile-identity.js`) — same approach the connect-identity gate uses.
- Atomic persistence pattern: `.tmp` + `rename` (see `saveState` / `appendErrorLog` in
  `campaign.js`); cooldown-file read/write helpers (`campaign.js:260-268`) as the shape to mirror.
- Picker render: `renderProfiles` (`app.js:919`/`:1012`), SoO badges `renderSoOBadges`
  (`app.js:782`); live render: `renderActiveProfiles` (`app.js:12580`), primary tag
  (`app.js:12612`).

## Architecture

### Persistent store — `src/primary-status-store.js` (new, pure + thin disk layer, unit-tested)

Pure functions over a plain object map; a thin load/save wraps the atomic-write disk layer.

- **Shape:** `data/primary-status.json` = `{ "<profileId>|<primaryKey>": { state, degree,
  verifiedAt, primaryUrl } }`. `primaryKey` = resolved member#/ACwAA if available, else
  normalized `/in/` slug — so "account A ↔ primary X" is reusable across any campaign using X.
- `getStored(map, profileId, primaryKey)` → entry | null.
- `shouldRecheck(entry)` → `false` iff `entry.state === 'connected'`; otherwise `true`
  (pending / unverified / missing).
- `mergeLiveRead(entry, liveState)` → new entry. Rules: `connected` is **sticky** (a later
  `unverified` does **not** demote it — fallback); a definitive `pending`/`connected` overwrites
  a prior non-connected; `unverified` over nothing stays `unverified`. Stamps `verifiedAt` only
  on definitive reads.
- `resolveDisplayState(entry, liveState)` → the state to show: live read wins unless it's
  `unverified` and the store has `connected` (then `connected`, flagged source=`remembered`).

### Campaign wiring — `src/campaign.js` (orchestration only)

- **On start:** load `primary-status.json`; seed `_primaryConn` for the configured primary from
  stored `connected` entries (these are trusted and skipped).
- **Per-account turn (`:2882`) / handshake (`:4085`):** before a live `readPrimaryDegree`, call
  `shouldRecheck` — skip if stored `connected`. After any live read, `mergeLiveRead` and persist
  (atomic). Apply the fallback in `resolveDisplayState` so a rate-limited `unverified` with a
  stored `connected` never emits "No Primary."
- **#7 timing:** a new campaign setting `primaryCheckTiming: 'immediately' | 'after_connections'`
  (default `'immediately'`).
  - `immediately` → existing pre-flight handshake path, unchanged.
  - `after_connections` → skip the pre-flight; run the handshake once at the **outreach→monitoring
    transition** (`campaign.js:4879-4889`), i.e. after all accounts have drained their connection
    sends for the day. (Exact prior ordering to be confirmed from git history during planning so
    this faithfully restores the old behavior.)

### Frontend — `public/js/app.js` + `public/css/style.css`

- **Variant 3 panel (running view):** a dedicated primary panel above/within `#active-profiles`
  — primary person + timing mode header, then per-account rows with a status LED, state label
  (Connected / Pending / Checking / Primary?), and a freshness/source line ("remembered · verified
  Nd ago" / "reading degree…" / "request sent · awaiting accept"). Driven by `_primaryConn` +
  store source. Hidden in non-primary modes.
- **Picker row:** in `renderProfiles`, when the mode uses a primary and a primary is configured,
  render a `.pick-primary` row inside each `.profile-item` from the **store only**
  (connected / pending / "not checked yet"), with the `remembered` marker. Hidden otherwise
  (not an empty row). Composes with existing dup/restricted flags.
- **CSS:** add `.prim`/state classes, `.v3-*` panel classes, `.pick-primary` classes, `.remember`
  marker — using app tokens, exactly as `public/sketches/primary-detection-variants.html`.

## Error handling / edge cases

| Case | Behavior |
|---|---|
| No `primary-status.json` yet | Store empty → everything re-checks once, then remembered. Identical to today. |
| Live read `unverified` + stored `connected` | Show `connected` (source=remembered). No "No Primary." |
| Live read confirms `pending`/`connected` | `mergeLiveRead` updates + persists; `connected` sticky. |
| Mode has no primary (e.g. `connect_only`) | No panel, no picker row, store untouched. |
| Primary not yet configured at pick-time | Picker row hidden until a primary is set. |
| Different primary than stored | Keyed by `primaryKey` → only the matching primary's entries apply. |
| Corrupt/unreadable store file | Treat as empty (log once); never block a campaign. |

## Testing

- **Pure unit tests** (`tests/primary-status-store.test.js`, `node:test`): `shouldRecheck`
  (connected→false, others→true), `mergeLiveRead` (sticky-connected, pending overwrite,
  unverified-no-demote, verifiedAt stamping), `resolveDisplayState` (fallback), key normalization.
- **Pure unit test** for the timing-mode mapping (`immediately`/`after_connections` → which path).
- **Manual in-app:** picker shows remembered status pre-start; restart preserves connected and
  skips its re-check; rate-limited read falls back to remembered (no false No Primary); V3 panel
  renders the live states; "After connections" defers the handshake to end of the connection phase;
  default "Immediately" path byte-for-byte unchanged.
- Full suite green; off-limits untouched; `data/monitoring-campaign.json` never staged.

## Done looks like

Open the picker in a CC+IC campaign with a primary set: accounts already connected show a green
**"Primary ✓ remembered"** row, pending ones **"Primary pending,"** the rest **"not checked yet"** —
all before starting, sourced from the store. Start the campaign: a prominent **primary panel** shows
each account's live detection (Connected / Pending / Checking / Primary?) with a freshness line.
Restart mid-run: connected accounts are remembered and not re-read; a rate-limited read on a
remembered account shows Connected, not "No Primary." Switch timing to **"After connections
complete"**: the campaign starts sending immediately and the primary handshake runs once all
accounts finish their connection sends — as it did before the recent change. Default timing and CC
behavior are unchanged; no off-limits files touched.
