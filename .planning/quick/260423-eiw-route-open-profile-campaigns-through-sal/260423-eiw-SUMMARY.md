---
phase: 260423-eiw
plan: 01
type: quick
status: complete
completed_date: "2026-04-23"
duration_min: 12
tasks_completed: 3
tasks_total: 3
files_created: 0
files_modified: 3
commits:
  - hash: eb7a64e
    message: "refactor(260423-eiw): extract resolveSalesNavUrlFromInProfile helper"
  - hash: 7bf5af3
    message: "feat(260423-eiw): route /in/ Open Profile campaigns through Sales Nav"
  - hash: 8d9f43a
    message: "fix(260423-eiw): block retry on deterministic Sales Nav skip reasons"
key-files:
  modified:
    - src/linkedin/actions.js
    - src/linkedin/outreach.js
    - src/campaign.js
key-decisions:
  - "Insert resolveSalesNavUrlFromInProfile helper directly above sendInMail at line 1110 (the plan referenced 'after closeSalesNavComposer' but that helper is defined at line 1614, AFTER sendInMail — so 'above sendInMail' was the only consistent placement)"
  - "Helper wraps each page.evaluate in try/catch and returns null on failure (never throws), giving callers full control over the failure mode"
  - "force_connect_op_fallback /in/ branch falls THROUGH to direct Connect when Sales Nav URL is unresolvable — this was the explicit intent in the plan (Connect campaign at heart, never skip a row just because Sales Nav is unavailable)"
requirements:
  - quick-260423-eiw
---

# Quick Task 260423-eiw Summary

One-liner: routed `/in/` Open Profile campaigns through Sales Navigator so `force_open_profile` and `force_connect_op_fallback` modes use the deterministic `sendViaSalesNav` flow instead of the free-sender-hostile `sendOpenProfileMessage` /in/ detector.

## What Changed

### src/linkedin/actions.js — new helper + sendInMail refactor

**New export — `resolveSalesNavUrlFromInProfile(page)`** (added at line 1121, immediately above `sendInMail`):

```
/**
 * Pure helper: clicks More dropdown on /in/ profile, extracts
 * "View in Sales Navigator" href via three-tier lookup. No
 * navigation. Returns absolute URL string or null. Never throws.
 */
export async function resolveSalesNavUrlFromInProfile(page): Promise<string | null>
```

- Same matching logic as the previous inline implementation: aria-label `'more actions'` / `'more'` / textContent `'more'` (case-insensitive).
- Same three-tier href lookup: dropdown-scoped anchor → any anchor with `/sales/lead/` or `/sales/people/` → text-match item with child `a[href]` containing "View in Sales Navigator".
- Both `page.evaluate` calls wrapped in `try/catch` returning `null` on any failure (page navigated mid-evaluate, etc.).
- Logs `'[actions] resolveSalesNavUrlFromInProfile: …'` on entry, success (with URL), and failure modes (More not found, href extract failed, no href in dropdown).

**`sendInMail` refactor** — replaced lines 1118–1157 (entry log, `moreOk` evaluate, 2500ms wait, `salesNavUrl` evaluate) with:

```js
const salesNavUrl = await resolveSalesNavUrlFromInProfile(page);
if (!salesNavUrl) throw new Error('INMAIL_SEND_FAILED: View in Sales Navigator href not found');
```

- The exact error string `'INMAIL_SEND_FAILED: View in Sales Navigator href not found'` is preserved verbatim, so `campaign.js:812` substring guard on `'INMAIL_SEND_FAILED'` keeps blocking retries.
- The pre-existing variant `'InMail button not found (More dropdown missing)'` is gone — both the "no More button" and "no Sales Nav href in dropdown" cases now collapse into the single `INMAIL_SEND_FAILED` error. `campaign.js:813` still independently guards `'InMail button not found'`, so retry behaviour is unchanged.
- Lines 1161–1192 (`page.goto`, 5s wait, `clickSalesNavMessageButton`, `readSalesNavComposerState`, credit check, `typeAndSendSalesNavComposer`, return) are untouched.
- `sendOpenProfileMessage` left in place per task_detail (still used by the default-mode opportunistic-OP path).

### src/linkedin/outreach.js — both /in/ branches rewritten

**Import (line 12)** — extended:
```js
import { sendConnectionRequest, sendMessage, sendInMail, sendOpenProfileMessage, sendViaSalesNav, resolveSalesNavUrlFromInProfile } from './actions.js';
```

**`force_open_profile` /in/ branch** (replaced original lines 250–262):
- Old: status check + `sendOpenProfileMessage` try/catch returning `op_message_sent` or `Open Profile failed: …`.
- New: status check → resolve Sales Nav URL → if null return `'Sales Nav link not available on profile'` → `page.goto` (try/catch) + 5s wait → `sendViaSalesNav({ mode: 'force_open_profile', opSubject, opBody })` → translate result via the same `if` chain used by the SALES_NAV_URL_RE short-circuit above.
- Output skip-reasons (deterministic): `'Sales Nav link not available on profile'`, `'Sales Nav Message button not found'`, `'NOT_OPEN_PROFILE: credit counter shown on Sales Nav panel'`, `'Sales Nav compose textbox did not appear'`, `` `Sales Nav send failed: ${result.error}` ``, `'Sales Nav: unknown result'`.

**`force_connect_op_fallback` /in/ branch** (replaced original lines 289–312):
- Old: `sendOpenProfileMessage` try/catch with `NOT_OPEN_PROFILE`-substring fall-through to direct Connect.
- New: if `opBody` set → resolve Sales Nav URL → if URL exists, navigate + `sendViaSalesNav({ mode: 'force_connect_op_fallback', … })` and translate result; if URL is null, log warning and FALL THROUGH to direct Connect path.
- Direct Connect fallback (`getConnectionStatus` + `sendConnectionRequest`) preserved intact for both the "URL unresolvable" path AND the "no opBody configured" path.
- `sendOpenProfileMessage` removed from this branch — the call moved to `sendViaSalesNav`'s internal panel-detection.

**Untouched:**
- `force_open_profile` SALES_NAV_URL_RE short-circuit (lines 230–244).
- `force_connect_op_fallback` SALES_NAV_URL_RE short-circuit (lines 273–285).
- Default-branch opportunistic-OP path that calls `sendOpenProfileMessage` before `sendInMail` (line 207).
- The `else { status = await getConnectionStatus(page); }` fallthrough and the subsequent switch.

### src/campaign.js — retry policy guards added

Appended 7 substring guards to the `isTransient` chain (lines 818–824), preserving the chain's `&&` line termination and final `;`:

| Substring                                     | Why deterministic                                         |
| --------------------------------------------- | --------------------------------------------------------- |
| `'Sales Nav link not available'`              | /in/ page has no Sales Nav link; refresh won't help       |
| `'Sales Nav compose textbox'`                 | composer never rendered after Message click               |
| `'Sales Nav send failed'`                     | sendViaSalesNav internal send failure (don't double-send) |
| `'Sales Nav: neither OP nor Connect'`         | no action surface on the Sales Nav lead page              |
| `'Already 1st-degree'`                        | lead is already connected — won't change                  |
| `'no_credits'`                                | catch-all from `result.error \|\| result.reason`           |
| `'no_compose_textbox'`                        | catch-all from `result.error \|\| result.reason`           |

Existing guards already cover the rest of Task 2's emitted strings:
- `'Sales Nav Message button not found'` ⊂ `'Message button not found'` (line 811)
- `'NOT_OPEN_PROFILE: credit counter shown …'` ⊂ `'NOT_OPEN_PROFILE'` (line 815)
- `'INMAIL_NO_CREDITS: …'` ⊂ `'INMAIL_NO_CREDITS'` (line 814)
- `'No Open Profile template'` (line 817)
- `'Already connected'` (line 798)

`'Sales Nav: unknown result'` is intentionally NOT guarded — unknown state could be transient.

## Verification

| Check                                                                                  | Result            |
| -------------------------------------------------------------------------------------- | ----------------- |
| `node -c src/linkedin/actions.js`                                                      | exit 0            |
| `node -c src/linkedin/outreach.js`                                                     | exit 0            |
| `node -c src/campaign.js`                                                              | exit 0            |
| Dynamic import of `resolveSalesNavUrlFromInProfile` and `sendInMail`                   | both functions    |
| `grep -c "sendOpenProfileMessage(" src/linkedin/outreach.js`                           | 1 (default branch only) |
| `grep -c "resolveSalesNavUrlFromInProfile" src/linkedin/outreach.js`                   | 3 (1 import + 2 call sites) |
| `npm test`                                                                             | 51 pass, 2 skipped, 0 fail |

**Test baseline match:** Pre-change baseline was 51 pass / 2 skipped / 0 fail on darwin. Post-change run: identical. No regressions, no pre-existing failures surfaced.

## Behavioural Notes

- **`force_open_profile` /in/** rows from free LinkedIn senders now actually attempt the send (via Sales Nav's free-vs-paid panel detection) instead of unconditionally returning `NOT_OPEN_PROFILE`. The fix surfaces previously-hidden 1st-degree skips and `Sales Nav link not available` skips that the old `sendOpenProfileMessage` path was masking.
- **`force_connect_op_fallback` /in/** rows now try Sales Nav first (better OP detection) BUT fall through to direct Connect when Sales Nav is unavailable — this preserves the campaign's "Connect at heart" semantics. Previously the fall-through was on `NOT_OPEN_PROFILE` substring; now it's on `salesNavUrl === null` (no More dropdown / no Sales Nav anchor).
- **`sendInMail`** observable behaviour unchanged: same error string, same downstream Sales Nav navigation, same credit-check + send logic. Only its dropdown lookup is now reused via the helper.
- **Retry tradeoff:** the new guards prevent up to 3 retries × 15-30s backoff = ~45-90s wasted per deterministically-skipped lead. Net throughput improvement scales with the OP-skip rate.

## Plan Deviations

**[Plan inconsistency — placement clarification, no rule applied]**
The plan's Task 1 instruction said to insert the helper "immediately above `sendInMail` (around line 1110, after the `closeSalesNavComposer` helper and before the `sendInMail` banner comment)". `closeSalesNavComposer` is actually defined at line 1614 — well AFTER `sendInMail` (1114). The "above sendInMail" location was the only consistent reading, so I inserted at line 1110 (just before the `sendInMail` banner comment). No behavioural impact — placement is purely organisational.

No Rule 1/2/3 deviations triggered. Plan executed as written for all behavioural changes.

## Self-Check: PASSED

- File `src/linkedin/actions.js` — modified, syntax OK, exports `resolveSalesNavUrlFromInProfile` and `sendInMail`.
- File `src/linkedin/outreach.js` — modified, syntax OK, helper imported + called in both /in/ branches.
- File `src/campaign.js` — modified, syntax OK, 7 new retry guards in place.
- Commit `eb7a64e` — present in `git log`.
- Commit `7bf5af3` — present in `git log`.
- Commit `8d9f43a` — present in `git log`.
- `npm test` — 51 pass, 2 skipped, 0 fail (matches baseline).
