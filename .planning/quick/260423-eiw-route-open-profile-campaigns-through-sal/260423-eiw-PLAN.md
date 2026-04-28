---
phase: 260423-eiw
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/linkedin/actions.js
  - src/linkedin/outreach.js
  - src/campaign.js
autonomous: true
requirements:
  - quick-260423-eiw
must_haves:
  truths:
    - "For a /in/ URL in force_open_profile mode, the bot navigates to the Sales Nav equivalent and sends via sendViaSalesNav (never via sendOpenProfileMessage)"
    - "For a /in/ URL in force_connect_op_fallback mode with an opBody, the bot attempts Sales Nav first; if the Sales Nav URL cannot be resolved it falls back to the /in/ Connect path"
    - "sendInMail continues to work unchanged in observable behavior after being refactored to use the new helper"
    - "resolveSalesNavUrlFromInProfile returns the Sales Nav href on success or null when no link is found (no navigation, no throw)"
    - "npm test still passes (51 pass, 2 skip on non-darwin)"
    - "node -c passes on all three modified files"
    - "campaign.js retry policy does not retry deterministic Sales Nav skips (link-not-available, Message-button-not-found, credit-counter-shown, compose-not-appearing, send-failed)"
  artifacts:
    - path: "src/linkedin/actions.js"
      provides: "resolveSalesNavUrlFromInProfile helper + refactored sendInMail"
      contains: "export async function resolveSalesNavUrlFromInProfile"
    - path: "src/linkedin/outreach.js"
      provides: "rewritten force_open_profile + force_connect_op_fallback /in/ branches routing through Sales Nav"
      contains: "resolveSalesNavUrlFromInProfile"
    - path: "src/campaign.js"
      provides: "retry policy confirmed to cover new skip reasons"
  key_links:
    - from: "src/linkedin/outreach.js (force_open_profile /in/ branch)"
      to: "sendViaSalesNav in src/linkedin/actions.js"
      via: "resolveSalesNavUrlFromInProfile → page.goto → sendViaSalesNav"
      pattern: "resolveSalesNavUrlFromInProfile.*sendViaSalesNav"
    - from: "src/linkedin/outreach.js (force_connect_op_fallback /in/ branch)"
      to: "sendViaSalesNav with mode=force_connect_op_fallback"
      via: "resolveSalesNavUrlFromInProfile → page.goto → sendViaSalesNav (fallback: /in/ Connect path if null)"
      pattern: "force_connect_op_fallback.*sendViaSalesNav"
    - from: "src/linkedin/actions.js sendInMail"
      to: "resolveSalesNavUrlFromInProfile"
      via: "shared helper"
      pattern: "sendInMail.*resolveSalesNavUrlFromInProfile"
---

<objective>
Route `/in/` Open Profile campaigns through Sales Navigator so `force_open_profile` and `force_connect_op_fallback` modes use the battle-tested `sendViaSalesNav` flow instead of `sendOpenProfileMessage`. This fixes two problems: (1) free LinkedIn senders getting `NOT_OPEN_PROFILE` for every lead on `/in/` rows, and (2) inconsistent routing between `/in/` rows and `/sales/…` rows.

Purpose: Make Open Profile campaigns work reliably for every sender tier by always sending through the Sales Nav composer (which has deterministic free-vs-paid panel detection and a clean Connect fallback).

Output: `resolveSalesNavUrlFromInProfile` helper extracted and exported, `sendInMail` refactored to use it, both Open-Profile-related `/in/` branches in `performOutreach` rewritten to navigate to Sales Nav + call `sendViaSalesNav`, retry policy verified.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@.planning/STATE.md

# Files being modified — read these in full before editing
@src/linkedin/actions.js
@src/linkedin/outreach.js
@src/campaign.js

<interfaces>
<!-- Contracts the executor must match exactly. Do NOT invent new shapes. -->

From src/linkedin/actions.js — existing sendViaSalesNav return shape (never throws):
```
{ ok: true,  kind: 'op_message_sent' }
{ ok: true,  kind: 'connection_sent' }
{ ok: true,  kind: 'inmail_sent', creditsLeft }
{ ok: false, reason: 'message_button_not_found' }
{ ok: false, reason: 'not_open_profile' }
{ ok: false, reason: 'no_compose_textbox' }
{ ok: false, reason: 'no_credits' }
{ ok: false, reason: 'unreachable', error }
{ ok: false, reason: 'send_failed', error }
{ ok: false, reason: 'unknown_mode' }
```

Existing call signature used by the Sales-Nav-URL short-circuit in outreach.js (reuse identically):
```
sendViaSalesNav(page, { mode: 'force_open_profile', opSubject, opBody })
sendViaSalesNav(page, { mode: 'force_connect_op_fallback', opSubject, opBody, connectionNote })
```

New helper contract to add in src/linkedin/actions.js (export named):
```
// Clicks the More dropdown on a /in/ profile, extracts the Sales Nav href using
// the three-tier lookup logic from the current sendInMail body (dropdown-scoped
// anchor → any anchor → "View in Sales Navigator" text-match). Does NOT navigate.
// Returns the absolute Sales Nav URL (string) on success, or null on failure.
// Never throws.
export async function resolveSalesNavUrlFromInProfile(page): Promise<string | null>
```

From src/linkedin/outreach.js existing imports (line 12) — extend, do not rewrite:
```
import { sendConnectionRequest, sendMessage, sendInMail, sendOpenProfileMessage, sendViaSalesNav } from './actions.js';
```

From src/linkedin/outreach.js — existing Sales-Nav-URL short-circuit translations to MIRROR for the new /in/ path (force_open_profile, lines 230-243):
```
if (result.ok && result.kind === 'op_message_sent') return { action: 'op_message_sent' };
if (result.reason === 'message_button_not_found')   return { action: 'skipped', error: 'Sales Nav Message button not found' };
if (result.reason === 'not_open_profile')           return { action: 'skipped', error: 'NOT_OPEN_PROFILE: credit counter shown on Sales Nav panel' };
if (result.reason === 'no_compose_textbox')         return { action: 'skipped', error: 'Sales Nav compose textbox did not appear' };
if (result.reason === 'send_failed')                return { action: 'skipped', error: `Sales Nav send failed: ${result.error}` };
return { action: 'skipped', error: 'Sales Nav: unknown result' };
```

And for force_connect_op_fallback (lines 273-285):
```
if (result.ok && result.kind === 'op_message_sent') return { action: 'op_message_sent' };
if (result.ok && result.kind === 'connection_sent') return { action: 'connection_sent' };
if (result.reason === 'unreachable')                return { action: 'skipped', error: 'Sales Nav: neither OP nor Connect available' };
if (result.reason === 'send_failed')                return { action: 'skipped', error: `Sales Nav send failed: ${result.error}` };
return { action: 'skipped', error: result.error || result.reason || 'Sales Nav unknown' };
```

Sales Nav navigation timing pattern (from current sendInMail, must match in outreach.js):
```
await page.goto(salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
// wrap in try/catch — navigation occasionally throws but the page is still usable
await new Promise(r => setTimeout(r, 5000));
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Extract resolveSalesNavUrlFromInProfile helper and refactor sendInMail to use it</name>
  <files>src/linkedin/actions.js</files>
  <action>
In src/linkedin/actions.js, extract the /in/ → Sales Nav href lookup currently embedded in sendInMail (lines 1118–1157) into a new exported helper, then have sendInMail call it.

1. Add a new exported async function `resolveSalesNavUrlFromInProfile(page)` immediately above the `sendInMail` export (around line 1110, after the closeSalesNavComposer helper and before the sendInMail banner comment). The helper MUST:
   - Click the More dropdown using the exact same button-text/aria matching currently in sendInMail lines 1120–1130 (match aria-label `'more actions'`, `'more'`, or visible text `'more'`, case-insensitive).
   - If the More button is not found, return `null` (do NOT throw — the helper must be pure and never throw, so the caller can choose its own failure mode).
   - Await 2500ms for the dropdown to render (match current sendInMail behavior).
   - Run the exact three-tier `page.evaluate` currently at lines 1135–1157: (a) dropdown-scoped `/sales/lead/` or `/sales/people/` anchor, (b) any anchor with those substrings, (c) `[role="button"]` / `.artdeco-dropdown__item` / `li` whose text includes `"View in Sales Navigator"` with a child `a[href]`. Return `a.href` on match, otherwise `null`.
   - Log `console.log('[actions] resolveSalesNavUrlFromInProfile: opening More dropdown…')` on entry and `console.log(...)` with the resolved URL (or a warning if null) for observability.
   - Return the absolute URL string or `null`. Never throw.

2. Refactor `sendInMail` (starting at line 1114) to call the helper:
   - Replace lines 1118–1157 (the logging line `[actions] InMail: opening More dropdown…`, the `moreOk` evaluate, the 2500ms wait, and the `salesNavUrl` evaluate) with:
     ```
     const salesNavUrl = await resolveSalesNavUrlFromInProfile(page);
     if (!salesNavUrl) throw new Error('INMAIL_SEND_FAILED: View in Sales Navigator href not found');
     ```
   - Preserve the EXACT existing error message `'INMAIL_SEND_FAILED: View in Sales Navigator href not found'` (the retry policy at campaign.js:812 matches `'INMAIL_SEND_FAILED'` as a substring — changing it could alter retry behavior).
   - Leave lines 1161–1192 (the `page.goto`, the 5000ms wait, `clickSalesNavMessageButton`, `readSalesNavComposerState`, credit check, `typeAndSendSalesNavComposer`, credits-left log, return) UNTOUCHED.
   - Note: the previous moreOk-specific error `'InMail button not found (More dropdown missing)'` (line 1130) is intentionally removed — both "no more button" and "no sales nav href in dropdown" now collapse into the single `INMAIL_SEND_FAILED` error above. This is acceptable because campaign.js:812 already blocks retries for any `INMAIL_SEND_FAILED` substring, and line 813 separately blocks `'InMail button not found'` retries — neither change retry behavior. Do not add a new error variant.

3. Do NOT delete `sendOpenProfileMessage` (it stays as dead code per task_detail — future cleanup).

4. Do NOT change any other exports, imports, or functions in actions.js.
  </action>
  <verify>
    <automated>node -c src/linkedin/actions.js && node -e "const m=require('./src/linkedin/actions.js'); if(typeof m.resolveSalesNavUrlFromInProfile!=='function') throw new Error('helper not exported'); if(typeof m.sendInMail!=='function') throw new Error('sendInMail missing'); console.log('exports ok');"</automated>
  </verify>
  <done>
    - `resolveSalesNavUrlFromInProfile` is exported from actions.js and returns a URL string or null without throwing.
    - `sendInMail` calls the helper and throws the EXACT string `'INMAIL_SEND_FAILED: View in Sales Navigator href not found'` when it returns null.
    - `node -c src/linkedin/actions.js` exits 0.
    - Dynamic require confirms both exports exist.
  </done>
</task>

<task type="auto">
  <name>Task 2: Rewrite force_open_profile and force_connect_op_fallback /in/ branches in performOutreach to route through Sales Nav</name>
  <files>src/linkedin/outreach.js</files>
  <action>
In src/linkedin/outreach.js, update the two /in/-branch paths inside `performOutreach` to navigate to Sales Nav first, then delegate to `sendViaSalesNav`. Do NOT touch the SALES_NAV_URL_RE short-circuits above them (they already work correctly).

1. Extend the existing import line at line 12 to include `resolveSalesNavUrlFromInProfile`:
   ```
   import { sendConnectionRequest, sendMessage, sendInMail, sendOpenProfileMessage, sendViaSalesNav, resolveSalesNavUrlFromInProfile } from './actions.js';
   ```
   Keep `sendOpenProfileMessage` in the import list — it's still used by the default (opportunistic-OP) branch at line 207.

2. Rewrite the `force_open_profile` /in/ path (lines 250–262 of current outreach.js, AFTER the SALES_NAV_URL_RE block which ends at line 244). Replace the entire block from `status = await getConnectionStatus(page);` through the closing `}` of the try/catch (the `catch (err) { return { action: 'skipped', error: 'Open Profile failed: ...' }; }` at line 261–262) with:
   ```js
   status = await getConnectionStatus(page);
   if (status === 'message') return { action: 'skipped', error: 'Already 1st-degree — use message mode' };
   if (!templates.openProfileBody) return { action: 'skipped', error: 'No Open Profile template' };

   const salesNavUrl = await resolveSalesNavUrlFromInProfile(page);
   if (!salesNavUrl) return { action: 'skipped', error: 'Sales Nav link not available on profile' };

   try {
     await page.goto(salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
   } catch (e) {
     console.warn(`[outreach] Sales Nav navigation issue: ${e.message}`);
   }
   await new Promise(r => setTimeout(r, 5000));

   const d = templates.data || {};
   const result = await sendViaSalesNav(page, {
     mode: 'force_open_profile',
     opSubject: personalizeTemplate(templates.openProfileSubject || '', d),
     opBody:    personalizeTemplate(templates.openProfileBody    || '', d),
   });
   if (result.ok && result.kind === 'op_message_sent') return { action: 'op_message_sent' };
   if (result.reason === 'message_button_not_found')   return { action: 'skipped', error: 'Sales Nav Message button not found' };
   if (result.reason === 'not_open_profile')           return { action: 'skipped', error: 'NOT_OPEN_PROFILE: credit counter shown on Sales Nav panel' };
   if (result.reason === 'no_compose_textbox')         return { action: 'skipped', error: 'Sales Nav compose textbox did not appear' };
   if (result.reason === 'send_failed')                return { action: 'skipped', error: `Sales Nav send failed: ${result.error}` };
   return { action: 'skipped', error: 'Sales Nav: unknown result' };
   ```
   This mirrors the existing SALES_NAV_URL_RE short-circuit's translation map (lines 238–243) exactly — the result object shape is identical, so the same `if` chain applies verbatim.

3. Rewrite the `force_connect_op_fallback` /in/ path. In the current code, the /in/ block starts at line 289 (`if (opBody) {`) and runs through line 312 (the closing `}` of the outer `} else if (modeHint === 'force_connect_op_fallback') {`). Replace from line 289 through the end of that branch (line 312) with:
   ```js
   // /in/ URL: try Sales Nav first (mirrors the SALES_NAV_URL_RE short-circuit
   // above). If the Sales Nav link is not resolvable from the /in/ page, fall
   // back to the direct /in/ Connect path — this is a Connect campaign at heart
   // and we should not skip entire rows just because Sales Nav is unavailable.
   if (opBody) {
     const salesNavUrl = await resolveSalesNavUrlFromInProfile(page);
     if (salesNavUrl) {
       try {
         await page.goto(salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
       } catch (e) {
         console.warn(`[outreach] Sales Nav navigation issue: ${e.message}`);
       }
       await new Promise(r => setTimeout(r, 5000));

       const result = await sendViaSalesNav(page, {
         mode: 'force_connect_op_fallback',
         opSubject: opSubj,
         opBody: opBody,
         connectionNote: note,
       });
       if (result.ok && result.kind === 'op_message_sent') return { action: 'op_message_sent' };
       if (result.ok && result.kind === 'connection_sent') return { action: 'connection_sent' };
       if (result.reason === 'unreachable')                return { action: 'skipped', error: 'Sales Nav: neither OP nor Connect available' };
       if (result.reason === 'send_failed')                return { action: 'skipped', error: `Sales Nav send failed: ${result.error}` };
       return { action: 'skipped', error: result.error || result.reason || 'Sales Nav unknown' };
     }
     // Sales Nav URL not resolvable — fall through to /in/ Connect fallback below.
     console.warn('[outreach] Sales Nav link not available on /in/ page — falling back to direct Connect');
   }

   // Connect fallback (also the path when opBody is empty)
   status = await getConnectionStatus(page);
   if (status === 'message') return { action: 'skipped', error: 'Already connected' };
   if (status === 'pending') return { action: 'already_processed' };
   try {
     await sendConnectionRequest(page, note);
     return { action: 'connection_sent' };
   } catch (err) {
     return { action: 'skipped', error: `Connect failed: ${err.message}` };
   }
   ```
   Key behavioral differences from the old code:
   - The old code called `sendOpenProfileMessage` then only fell through to Connect on the `NOT_OPEN_PROFILE` substring. The new code delegates to `sendViaSalesNav` which already handles OP-success / paid-panel-→-Connect / no-composer-→-Connect internally within a single Sales Nav visit.
   - The `salesNavUrl === null` case is the NEW fall-through to the direct /in/ Connect path. This is deliberate per task_detail: force_connect_op_fallback is a Connect campaign at heart.

4. Do NOT touch the `force_open_profile` SALES_NAV_URL_RE short-circuit (lines 230–244) or the `force_connect_op_fallback` SALES_NAV_URL_RE short-circuit (lines 273–285) — they already work.

5. Do NOT touch the default branch's opportunistic-OP path (lines 205–224) that uses `sendOpenProfileMessage` before InMail. That's a different flow and out of scope.

6. Leave the `else { status = await getConnectionStatus(page); }` fallthrough (line 314) and the subsequent switch statement UNTOUCHED.
  </action>
  <verify>
    <automated>node -c src/linkedin/outreach.js && node -e "const fs=require('fs'); const s=fs.readFileSync('src/linkedin/outreach.js','utf8'); if(!s.includes('resolveSalesNavUrlFromInProfile')) throw new Error('helper not imported/used'); const opCount=(s.match(/sendOpenProfileMessage\(/g)||[]).length; if(opCount!==1) throw new Error('sendOpenProfileMessage should be called exactly once (default branch only), found '+opCount); console.log('outreach.js ok — sendOpenProfileMessage calls:', opCount);"</automated>
  </verify>
  <done>
    - `resolveSalesNavUrlFromInProfile` is imported and called in both force_open_profile and force_connect_op_fallback /in/ branches.
    - `sendOpenProfileMessage` is called exactly once (the default-mode opportunistic-OP path at line ~207) — the two force_* branches no longer call it.
    - force_open_profile /in/ branch returns `{ action: 'skipped', error: 'Sales Nav link not available on profile' }` when the helper returns null.
    - force_connect_op_fallback /in/ branch falls through to the direct Connect path when the helper returns null (no early-return on null).
    - `node -c src/linkedin/outreach.js` exits 0.
  </done>
</task>

<task type="auto">
  <name>Task 3: Verify campaign.js retry policy covers all new skip reasons and run the test suite</name>
  <files>src/campaign.js</files>
  <action>
Audit `src/campaign.js` lines 793–818 (the `isTransient` retry-filter chain inside `performOutreach`'s retry loop) against every new skip-reason string emitted by Task 2. For each new string, check whether an existing substring guard already excludes it from retries. Add substrings for any that slip through.

New skip-reason strings emitted by Task 2 (force_open_profile /in/ branch):
1. `'Already 1st-degree — use message mode'` — NEW in /in/ path (was already emitted by SALES_NAV_URL_RE short-circuit, so presumably fine; `'Already connected'` is at line 798 but doesn't match). Check if this should be non-retryable. Decision: deterministic (the lead IS 1st-degree), so add `'Already 1st-degree'` to the guard chain.
2. `'No Open Profile template'` — already covered by line 817 (`'No Open Profile template'`).
3. `'Sales Nav link not available on profile'` — NEW, deterministic (the /in/ page has no Sales Nav link; refreshing won't help). Add `'Sales Nav link not available'` as a new guard.
4. `'Sales Nav Message button not found'` — covered by line 811 (`'Message button not found'` substring match).
5. `'NOT_OPEN_PROFILE: credit counter shown on Sales Nav panel'` — covered by line 815 (`'NOT_OPEN_PROFILE'` substring).
6. `'Sales Nav compose textbox did not appear'` — NOT covered. Add `'Sales Nav compose textbox'` as a new guard.
7. `` `Sales Nav send failed: ${result.error}` `` — NOT covered (no existing `'Sales Nav send failed'` or `'send_failed'` guard). Add `'Sales Nav send failed'` as a new guard.
8. `'Sales Nav: unknown result'` — unknown state; it's reasonable to retry (could be transient). Do NOT add a guard.

New skip-reason strings emitted by Task 2 (force_connect_op_fallback /in/ branch):
9. `'Sales Nav: neither OP nor Connect available'` — deterministic (the profile has no action surface). Add `'Sales Nav: neither OP nor Connect available'` (or a substring like `'neither OP nor Connect'`).
10. `` `Sales Nav send failed: ${result.error}` `` — already added above.
11. A catch-all from `result.error || result.reason || 'Sales Nav unknown'` — covers cases like `'not_open_profile'`, `'no_credits'`, `'no_compose_textbox'` without the nice prefix. These are all deterministic from Sales Nav's panel inspection. Add `'no_credits'` as a guard. (`'no_compose_textbox'` matches the `'Sales Nav compose textbox'` addition via catch-all only if `result.error` is present; safer to also add `'no_compose_textbox'`.)

Edit — add the following `&& !result.error.includes(...)` lines to the `isTransient` chain immediately before line 819's `if (!isTransient || ...` (i.e., append them to the chain after line 817):
```
              !result.error.includes('Sales Nav link not available') &&
              !result.error.includes('Sales Nav compose textbox') &&
              !result.error.includes('Sales Nav send failed') &&
              !result.error.includes('Sales Nav: neither OP nor Connect') &&
              !result.error.includes('Already 1st-degree') &&
              !result.error.includes('no_credits') &&
              !result.error.includes('no_compose_textbox') &&
```
Ensure the final line still ends with `;` (i.e., the last appended `&& !result.error.includes(...)` becomes the new line just before the existing `!result.error.includes('No Open Profile template');` — actually append AFTER that last existing line, so line 817's trailing `;` moves to the new final condition). Re-read lines 793–818 after editing to confirm the chain is syntactically clean (every line except the last ends in `&&`, the last line ends in `;`).

Finally, run the test suite and syntax-check all three modified files:
- `npm test` must pass (51 passing, 2 pending/skipped on non-darwin is fine).
- `node -c src/linkedin/actions.js`, `node -c src/linkedin/outreach.js`, `node -c src/campaign.js` must all exit 0.

If `npm test` fails, inspect the failure — if it's an existing-test regression unrelated to these changes, proceed (document in SUMMARY). If it's a new failure caused by these edits, roll back and diagnose.
  </action>
  <verify>
    <automated>node -c src/linkedin/actions.js && node -c src/linkedin/outreach.js && node -c src/campaign.js && npm test 2>&1 | tail -20</automated>
  </verify>
  <done>
    - campaign.js retry-filter chain includes guards for: `'Sales Nav link not available'`, `'Sales Nav compose textbox'`, `'Sales Nav send failed'`, `'Sales Nav: neither OP nor Connect'`, `'Already 1st-degree'`, `'no_credits'`, `'no_compose_textbox'`.
    - All three files pass `node -c`.
    - `npm test` reports the expected pass count (51 passing, 2 skipped on non-darwin) or documents any pre-existing failures as such.
    - No new test failures introduced by this plan.
  </done>
</task>

</tasks>

<verification>
Overall sanity checks after all three tasks:

1. **No broken imports:** `node -e "require('./src/linkedin/actions.js'); require('./src/linkedin/outreach.js'); require('./src/campaign.js'); console.log('all three load ok')"` exits 0.

2. **Helper is reachable from outreach.js:** `node -e "const m=require('./src/linkedin/outreach.js'); console.log(typeof m.performOutreach)"` prints `function`.

3. **`sendOpenProfileMessage` is dead in the force_* branches:** grep confirms exactly one call site in outreach.js (the opportunistic-OP path in the default branch):
   ```
   grep -c "sendOpenProfileMessage(" src/linkedin/outreach.js
   # expected: 1
   ```

4. **Retry-policy chain is syntactically valid:** `node -c src/campaign.js` exits 0 AND a quick eyeball of lines 793–830 confirms every `&&` line is terminated correctly and the final `includes(...)` ends with `;`.

5. **npm test:** 51 pass, 2 skipped on macOS (or equivalent on the developer's machine).

Note: The DOM-dependent Sales Nav navigation cannot be unit-tested (no linkedin/* tests exist — integration-tested via the app per task_detail). This is acceptable.
</verification>

<success_criteria>
- `/in/` URLs in `force_open_profile` mode navigate to Sales Nav then call `sendViaSalesNav({ mode: 'force_open_profile', ... })` — no longer call `sendOpenProfileMessage`.
- `/in/` URLs in `force_connect_op_fallback` mode attempt Sales Nav first; fall back to /in/ Connect only when Sales Nav URL cannot be resolved.
- `sendInMail` behavior is unchanged observably, but its internals reuse the new `resolveSalesNavUrlFromInProfile` helper.
- `npm test` green; `node -c` clean on all three modified files.
- Retry policy in campaign.js does not retry any of the new deterministic Sales Nav skip reasons.
</success_criteria>

<output>
After completion, create `.planning/quick/260423-eiw-route-open-profile-campaigns-through-sal/260423-eiw-SUMMARY.md` documenting:
- Final signature of `resolveSalesNavUrlFromInProfile`
- Exact lines changed in outreach.js (the two /in/ branches)
- The list of substrings added to the retry guard in campaign.js
- `npm test` result (pass/fail counts)
- Any pre-existing test failures surfaced (note as pre-existing, not introduced)
- Any behavioral edge cases noticed during implementation (e.g., Sales Nav redirect loops, profile pages that have Sales Nav links under unexpected selectors — if any)
</output>
