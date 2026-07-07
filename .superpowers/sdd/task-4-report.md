# Task 4 Report — Skipped-leads panel (v2.138.0)

## Files changed

- `public/css/dashboard-v0.3.css` — Added `.active-skips*` and `table.skiptab` CSS classes (hairline/monochrome, gold for reason labels)
- `public/js/app.js` — Added `renderActiveSkips()`, `_fetchAndRenderSkips()`, `_renderSkipsTable()`, `window.activeSkipsExpand()`, `window.activeSkipsCollapse()`, `window.activeSkipsCopy()`, `_stopSkipsPoller()`, `SKIP_REASON_LABELS` map; wired into all three branches of `window.renderActiveCard`
- `public/index.html` — Added `<div class="active-skips" id="active-skips" hidden>` placeholder before closing `</section>` of `#active-card`
- `package.json` — Version 2.138.0 (already bumped by a prior task on this branch)

## Poller wiring

`renderActiveSkips(count)` is called from inside `window.renderActiveCard(status)` which is itself called by `pollStatus()` every 2 seconds (line 8133 of app.js). Three call sites:

1. **isFinished branch** — calls `renderActiveSkips(status.skippedCount || 0)` then returns; section stays visible at campaign end.
2. **idle branch** — hides `#active-skips` and calls `_stopSkipsPoller()` before returning.
3. **running/monitoring branch** — calls `renderActiveSkips(status.skippedCount || 0)` at the very end; count comes from `skippedCount` in the `/api/campaign/status` response.

When the user expands the table, a separate `setInterval(..., 2000)` timer fires `_fetchAndRenderSkips()` to keep the table body current against `/api/campaign/skips`. The poller is cleared on collapse or when the card goes idle.

## Behaviour summary

- Collapsed: shows pill "Skipped so far: N" + "view" link — only when N > 0
- Expanded: compact table (Row # | Lead | Account | Reason), head shows ⚠ count, acts row has "Copy list" + "Collapse"
- Copy list: plain text, one line per skip: `Row N · lead name · Human label · detail`
- No "Retry these" button (out of scope per brief)
- Persists at campaign end (isFinished branch renders it)
- HTML-escaped via `escHtml()` throughout

## Verification

- `node --check public/js/app.js` → OK
- `node --test tests/*.test.js` → 1104 pass, 0 fail, 2 skipped (pre-existing)
