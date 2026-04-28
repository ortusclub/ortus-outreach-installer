# Ortus Outreach — Soft-Warning Aggregation

**Date:** 2026-04-27
**Lens:** D (Throughput / rate-limit safety) — focused on operator visibility into LinkedIn soft warnings
**Approach:** Single-sweep surgical patch series, three patches in one branch, one ship
**Target version:** 2.8.22
**Memory anchors:** never modify `src/linkedin/outreach.js` or `src/linkedin/actions.js` (off-limits — user has been burned); verify-before-asserting (no guessing about LinkedIn message phrases — only aggregate what's already detected); be careful with working code (additive only, no behavior changes to detection or pacing).

## Scope

Three patches in one branch (`throughput-2.8.22`), shipped as a single version bump.

| Patch | Theme | Risk |
|---|---|---|
| **W1** | State + inspection | Low (additive — new state field, helper called at existing detection consumption sites) |
| **W2** | UI surface | Low (additive — new right-pane row mirroring parked pattern) |
| **W3** | NDJSON persistence | Low (additive — new helper, new endpoint, new file) |

Lens A (operator UX, 2.8.19) and lens B (reliability, 2.8.20) established the patterns this lens reuses. Phase 11.1 (resource-aware execution) and phase 11.2 (batch-mode + window management) already shipped batches-per-hour pacing, dynamic throttle, and lazy profile lifecycle. This lens adds **observability** over what's already detected — no new pacing, no automatic reaction.

**Out of scope:**
- Any change to `src/linkedin/outreach.js`, `src/linkedin/actions.js` (off-limits per memory)
- New detection logic for additional LinkedIn message phrases (per user choice — aggregate-only)
- Automatic reaction to warnings (per user choice — notify-only, operator decides)
- Retroactive ingestion of past warnings from `data/history.json`
- Email / Slack / push notifications when warnings fire
- Per-account throttle adjustments based on warning count

**Verification cadence:** Single end-of-branch verification (no mid-wave checkpoints — three patches all small and additive).

---

## W1 — State + detection inspection

**Problem:** `src/linkedin/actions.js` already detects soft-warning conditions like `hasWeeklyLimit` (8 phrase matches), `hasEmailRequired` (3 phrase matches), and `hasHowDoYouKnow`, returning them as flags. `src/linkedin/outreach.js:163-176` detects `rate_limited`, `page_not_found`, `linkedin_error` as page errors. These signals fire one-shot per action and bubble up to `src/campaign.js:1011-1180`. The campaign loop reacts (skip the lead, log to history), but the warnings are not aggregated per-account anywhere — there's no list the operator can review later.

**Change:**

In `src/campaign.js`:

- Add `softWarnings: []` to the `campaign` state object near the existing `parkedProfiles: []` field added in 2.8.20 (around line 170 — exact location to verify in implementation)
- Reset `softWarnings = []` in `startCampaign()` alongside the other state resets (around line 461)
- Add a new pure helper `pushSoftWarning(state, { profileId, pName, kind, message })` that:
  - Dedupes: if an entry with the same `(profileId, kind)` was added in the last 10 min (`SOFT_WARNING_DEDUPE_MS = 10 * 60 * 1000`), return without adding
  - Caps the in-memory list at 200 entries — when exceeded, drop oldest (FIFO trim, matching `errors` cap behavior)
  - Pushes the entry: `{ profileId, pName, kind, message, detectedAt: Date.now() }`
- At the existing inspection sites in `campaign.js`, call `pushSoftWarning(campaign, { ... })`:
  - Around line 1048 (where `rate_limited` is recognized): `pushSoftWarning(campaign, { profileId, pName, kind: 'rate_limited', message: 'LinkedIn rate-limit page shown' })`
  - Around line 1180 (where `auditAction: 'Weekly invitation limit reached'` is logged): `pushSoftWarning(campaign, { profileId, pName, kind: 'weekly_limit', message: 'Weekly invitation limit reached' })`
  - At the call site that consumes the modal-detection flags from `actions.js` (need to grep during implementation; the consumer site is in `campaign.js` proper, not in the off-limits `linkedin/*` files): if `hasWeeklyLimit` → `pushSoftWarning({ kind: 'weekly_limit', message: 'Weekly invitation limit modal' })`; if `hasEmailRequired` → `pushSoftWarning({ kind: 'email_required', message: 'LinkedIn requires email to connect' })`; if `hasHowDoYouKnow` → `pushSoftWarning({ kind: 'how_do_you_know', message: 'LinkedIn asked how do you know this person' })`
- Bubble into `getCampaignStatus()` payload around line 1456: `softWarnings: campaign.softWarnings.slice()`

**Pure-helper test:** New `tests/soft-warning-helper.test.js` (3-4 tests) covering:
- Push happy path (entry added, returned by helper)
- Dedupe within window (same profileId+kind within 10 min → no second entry)
- Dedupe expires after window (same profileId+kind after 10 min → second entry added)
- Cap at 200 (push 201 entries → length stays at 200, oldest evicted)

**Acceptance:**
- New `softWarnings` field present in `getCampaignStatus()` payload
- Helper handles dedupe + cap correctly via unit tests
- Existing tests pass (114 from 2.8.21 baseline)
- No change to existing detection logic, no change to existing reaction (skip lead, log to history)

**Risk:** Low. All changes are additive: a new state field, a new helper, calls at three existing inspection points. No off-limits files touched. No change to performOutreach internals.

---

## W2 — UI surface

**Problem:** Without a UI, the new state field in W1 is invisible to operators. The dashboard cockpit needs a row showing accumulated warnings per account.

**Change:**

In `public/index.html`:

Add a new right-pane row, positioned between the existing `#rp-parked-row` (added in 2.8.20-B1) and the next downstream section. Mirrors the parked row's structure:

```html
<div class="rp-section" id="rp-warnings-row" hidden>
  <div class="rp-label" data-edit="rp-label-warnings">Warnings</div>
  <div class="rp-warnings-line" id="rp-warnings-line">—</div>
  <div class="rp-warnings-detail" id="rp-warnings-detail" hidden></div>
</div>
```

Exact insertion line to be verified during implementation against the current `index.html` after restoration commit `2c9bcff`.

In `public/css/style.css`:

Add monochrome-only styling matching `.rp-parked-line` / `.rp-parked-detail`:

```css
.rp-warnings-line {
  font: 11px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--ink);
  cursor: pointer;
  margin-top: 2px;
}
.rp-warnings-line:empty::before { content: '—'; color: var(--ink-dim); }
.rp-warnings-detail {
  margin-top: 4px;
  padding: 4px 6px;
  border-left: 1px solid var(--hairline);
  font: 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--ink-dim);
}
```

(Color tokens from existing variables; no new color introduced.)

In `public/js/app.js`:

Add three new helpers (mirror `renderParkedProfiles` / `_prettyParkReason` / `toggleParkedDetail`):

- `_prettyWarningKind(kind)` — maps `'weekly_limit'` → `'Weekly limit'`, `'rate_limited'` → `'Rate limited'`, `'email_required'` → `'Email required'`, `'how_do_you_know'` → `'Know-them prompt'`, `'page_error'` → `'Page error'`, anything else → `'Warning'`
- `renderSoftWarnings(warnings)` — given the array, builds a one-line summary like `Adam · Weekly limit · 12m ago` for the most recent, plus a count `(+3 more)` if length > 1; toggles row visibility
- `toggleWarningDetail()` — onclick handler for the line; expands/collapses the detail block showing the full list

Wire `renderSoftWarnings(s.softWarnings)` into the existing `pollStatus()` function alongside `renderParkedProfiles(s.parked)`.

**Acceptance:**
- When `softWarnings` is empty: row is hidden
- When `softWarnings` has entries: row visible, shows most-recent + count
- Click expands detail showing all entries with profile name, kind, message, timestamp
- Visual is monochrome (no new colors introduced)
- Console (DevTools) shows no JS errors during normal poll cycles

**Risk:** Low. Additive UI — new row, new CSS class, new JS helpers. No existing rendering paths touched.

---

## W3 — NDJSON persistence

**Problem:** Without persistence, soft warnings disappear when the operator restarts the app. Operators don't watch the dashboard 24/7 — they need to review what fired overnight.

**Change:**

In `src/campaign.js`:

- Add constant: `const WARNINGS_LOG_FILE = resolve(DATA_DIR, 'warnings-log.ndjson')`
- Add helper `appendWarningLog(entry)`:
  ```js
  async function appendWarningLog(entry) {
    try {
      const line = JSON.stringify(entry) + '\n';
      await appendFile(WARNINGS_LOG_FILE, line);
    } catch (err) {
      // Non-fatal — log to console, don't throw
      console.warn('[appendWarningLog]', err.message);
    }
  }
  ```
  (Async, not sync — soft warnings aren't crash-critical, no need for sync write like `appendFatalErrorSync`.)
- In `pushSoftWarning`, after a non-deduped push: `appendWarningLog(entry)` (fire-and-forget; intentionally not awaited)

In `server.js`:

- Add new endpoint `GET /api/warnings` that returns the last 200 entries from `data/warnings-log.ndjson`:
  ```js
  app.get('/api/warnings', async (_req, res) => {
    try {
      const buf = await readFile(WARNINGS_LOG_FILE, 'utf-8').catch(() => '');
      const lines = buf.split('\n').filter(Boolean);
      const entries = lines.slice(-200).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      res.json({ warnings: entries });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
  ```
  (Same shape as `GET /api/errors` added in 2.8.20-B2.)

In `public/js/app.js`:

- Add `loadPersistedWarnings()` async function (mirror `loadPersistedErrors`):
  ```js
  async function loadPersistedWarnings() {
    try {
      const r = await fetch('/api/warnings');
      if (!r.ok) return;
      const { warnings } = await r.json();
      _persistedWarnings = warnings || [];
    } catch {}
  }
  ```
- In the startup IIFE near where `loadPersistedErrors()` is called: also call `loadPersistedWarnings()`
- Modify `renderSoftWarnings(s.softWarnings)` to merge runtime + persisted entries by `(profileId, kind, detectedAt)` for the count badge — runtime takes precedence on overlapping keys (handles the case where the persisted entry is the same one the runtime just added)

**Acceptance:**
- File `data/warnings-log.ndjson` is created on first warning, appended-to on subsequent warnings
- Each line is valid JSON
- After server restart, `GET /api/warnings` returns the last 200 persisted entries
- Frontend merges persisted + runtime correctly (no duplicate counts when both sources have the same recent entry)
- File grows append-only — no truncation, no rewrite (operator can rotate manually if needed)

**Risk:** Low. Pattern proven in 2.8.20 (`appendFatalErrorSync`, `/api/errors`, `loadPersistedErrors`). Async append is non-blocking; failure to write a single warning is non-fatal.

---

## Risks summary

| Patch | Risk level | Worst case | Mitigation |
|---|---|---|---|
| W1 | Low | A `pushSoftWarning` call point misidentified, missing one warning kind | Implementation greps the consumption sites first; missing one is recoverable in a follow-up |
| W2 | Low | Right-pane row layout breaks on narrow viewports | Mirrors existing `#rp-parked-row` which already handles narrow viewports |
| W3 | Low | NDJSON file grows unbounded | Operator can `rm` the file if it grows large; could add rotation in a future patch |

## Branch & version shape

- Branch: `throughput-2.8.22` cut from `main` (currently at `2c9bcff` after the restoration commit)
- Patches commit in order W1 → W2 → W3
- FINAL commit bumps `package.json` version 2.8.21 → 2.8.22
- Single end-of-branch verification: `npm test` green + manual UI smoke (operator triggers a known warning, confirms it appears in the Warnings row and the NDJSON file)
- Merge to main as fast-forward (matches 2.8.19 / 2.8.20 / 2.8.21 pattern)

## Files touched (summary)

| File | W1 | W2 | W3 | FINAL |
|---|---|---|---|---|
| `src/campaign.js` | state + helper + 3 call sites + payload | | log file constant + append helper + call from pushSoftWarning | |
| `tests/soft-warning-helper.test.js` | NEW (3-4 tests) | | | |
| `public/index.html` | | new `#rp-warnings-row` | | |
| `public/css/style.css` | | new `.rp-warnings-line` / `.rp-warnings-detail` | | |
| `public/js/app.js` | | 3 helpers + wire to pollStatus | `loadPersistedWarnings` + startup call + merge | |
| `server.js` | | | new `GET /api/warnings` | |
| `package.json` | | | | bump to 2.8.22 |

## Notes for the implementer

- **Off-limits files**: `src/linkedin/outreach.js`, `src/linkedin/actions.js`. All inspection happens in `src/campaign.js` at the existing consumption sites. If a new detection path emerges that REQUIRES touching these files, STOP and escalate.
- **Pattern reuse**: every component in this spec mirrors something already in the codebase. Read 2.8.20 commits (`b1` parked profiles, `b2` error log helper, `c2` disk status banner) as references before writing new code.
- **No re-detection**: this lens does NOT add new phrase matchers. The user explicitly chose "aggregate existing detections only".
