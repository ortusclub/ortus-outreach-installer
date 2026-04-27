---
review_target: Connection-campaign + Open-Profile-messaging code paths
reviewed: 2026-04-24
depth: standard (manual, scoped to flows requested)
files_reviewed:
  - src/linkedin/outreach.js
  - src/linkedin/actions.js
  - src/linkedin/helpers.js
  - src/campaign.js (lines ~457-1100)
findings:
  critical: 0
  high: 4
  medium: 5
  low: 3
  info: 3
  total: 15
---

# Review: Connection campaign + Open-Profile messaging

## Scope reminder
Out of scope: GoLogin SDK internals, Check DMs (Phase 11.3), cockpit UI, auth/server, templates UI, tests.

---

## High

### H-01: URL-transform regexes silently drop URLs that contain a `#fragment`
**File:** `src/linkedin/outreach.js:23, :28`

`IN_MEMBER_URN_RE` and `SALES_MEMBER_URN_RE` only allow the URN to be terminated by `/`, end-of-string, `?`, or (for sales) `,`. They do **not** allow `#`. Verified empirically:

```
SALES_NAV_URL_RE.test("https://www.linkedin.com/sales/lead/ACw…#tab=foo")  → true
SALES_MEMBER_URN_RE.match(    "       /sales/lead/ACw…#tab=foo")           → null
```

Consequence: a `force_connect` campaign on a Sales-Nav URL that carries a hash fragment (LinkedIn does emit these — `#chat`, `#tab=…`, copy-paste from a deep-linked tab) returns `{ action: 'skipped', error: 'Sales Nav URL not in member-URN format — cannot route to /in/' }`, and the row is shelved as a non-success outcome (campaign.js:~1080 → `auditAction: errorMsg`). The same affects `force_open_profile` / `force_inmail` for `/in/…#…` URLs.

**Fix:** add `#` to the trailing alternation in **both** regexes:

```js
const IN_MEMBER_URN_RE       = /\/in\/(AC[A-Za-z0-9_-]{10,})(?:[/?#]|$)/;
const SALES_MEMBER_URN_RE    = /\/sales\/(?:lead|people)\/(AC[A-Za-z0-9_-]{10,})(?:[,/?#]|$)/;
```

Also strip `#fragment` before `page.goto` to avoid LinkedIn auto-routing into `#chat` / overlay views.

---

### H-02: `op_message_sent` from Connect-mode does not stamp the CC column
**File:** `src/campaign.js:967-970` (and contrast with `:948-954`)

Phase 2.8.10 changed `connection_sent` to write `pName` into CC so the operator can see at a glance which sender produced the invite. But when the same Connect-campaign run reaches a lead through the OP path (mode = `connect_only` + `messageOpenProfiles=true` + lead is Open Profile), the success branch is `op_message_sent` and we only write `op = HYPERLINK(…,sent)` — CC stays blank. Operators auditing the CC column will think those leads were never touched by the Connect campaign and may re-process them on a follow-up run.

There is even *dead code* at line 960 (`if (messageOpenProfiles && isOpenProfile === 'yes')` under the `message_sent` branch) that reads like an aborted attempt at this idea — but `force_connect_op_fallback` never returns `message_sent`, only `op_message_sent` / `connection_sent`. The branch is unreachable from this code path.

**Fix:** in the `op_message_sent` branch, when this run came from `connect_only` + `messageOpenProfiles`, stamp CC with `pName` too:

```js
} else if (result.action === 'op_message_sent') {
  sheetData.status = 'Done';
  sheetData.op = hyperSent;
  if (mode === 'connect_only' && messageOpenProfiles) {
    sheetData.cc = pName;          // mirrors connection_sent stamping
    sheetData.auditAction = 'Open Profile message sent (via connect mode)';
  } else {
    sheetData.auditAction = 'Open Profile message sent';
  }
}
```

Then delete the dead `messageOpenProfiles && isOpenProfile === 'yes'` branch under `message_sent` (lines 960-966).

---

### H-03: `isTransient` allow-list is missing several non-retryable errors
**File:** `src/campaign.js:872-902`

The deny-list correctly excludes `WEEKLY_LIMIT`, `INMAIL_NO_CREDITS`, `NOT_OPEN_PROFILE`, `MESSAGE_SEND_FAILED`, etc. — good. However, several error strings that `outreach.js` / `actions.js` produce are NOT in the deny-list and will cause **3× wasted retries (15s + 30s = 45s of sleeps)** on definitively non-transient outcomes:

| Error string emitted | Source | Should retry? |
|---|---|---|
| `URL not in member-URN format` (both `/in/` and `/sales/`) | outreach.js:65, :82 | **No** (sheet data won't change between attempts) |
| `LinkedIn session expired (no li_at cookie)` | outreach.js:95 | **No** (need a session refresh, not a retry) |
| `Login page detected` is excluded but `Profile not found` (outreach.js:159) is not | outreach.js:159 | **No** (profile is gone) |
| `Page error: rate_limited` / `page_not_found` / `linkedin_error` | outreach.js:174 | `rate_limited` arguably yes, the others no |
| `Connect button not found after 60s` | actions.js:571 | Marginal — the per-attempt 30s polling already retried; a top-level retry just doubles the cost |
| `No InMail template` (variant of "no template") | not currently emitted but in scope | **No** |

**Fix:** prefer an **allow-list of transient signals** (network/timeout/`detached frame`/`page closed`) instead of the current open-ended deny-list. As written, any unforeseen new error string defaults to transient and burns 45 s. Concretely:

```js
const TRANSIENT_SIGNALS = [
  'Navigation timeout', 'net::ERR_', 'Target closed', 'detached',
  'Execution context was destroyed', 'Protocol error',
  'Page error: rate_limited',
];
const isTransient = result.action === 'skipped' && !!result.error
  && TRANSIENT_SIGNALS.some(s => result.error.includes(s));
```

Or, at minimum, add the missing strings above to the existing deny-list.

---

### H-04: Connect-mode `op_message_sent` is filtered out next run by stale OP=`Sent` check
**File:** `src/campaign.js:817-819, :811`

The in-loop skip check at line 817 reads:

```js
if ((mode === 'open_profile_only' || mode === 'message_only') && msgSent) { ... continue }
```

— good for those two modes. But for `connect_only`, the pre-filter at line 547-552 **only skips on a non-empty CC**. After H-02 above writes nothing to CC (status quo) or after the proposed fix writes CC=pName, OP=`sent` from a previous Connect-campaign run won't block a re-process *if CC is empty*. With the H-02 fix in place this becomes consistent (CC=pName guards re-processing). Without H-02, the second time you run a Connect campaign with messageOpenProfiles=ON over the same sheet, every lead that we already messaged via OP **will be re-attempted** — re-sending the OP message — because the connect_only pre-filter does not look at OP at all.

**Fix:** either land H-02 (CC stamp closes the loophole) **or** extend the connect_only pre-filter to also reject `opCell === 'sent'` when `messageOpenProfiles` is on:

```js
if (mode === 'connect_only') {
  if (cc) return false;
  if (messageOpenProfiles && opCell === 'sent') return false;   // NEW
  if (state.processed[url]) return false;
  return true;
}
```

(The pre-filter at line 530-552 doesn't currently receive `messageOpenProfiles` — it's in the closure scope of `startCampaign`, so the access works.)

---

## Medium

### M-01: `getModeHint` does not flow `force_connect_op_fallback` for `connect_and_message` mode
**File:** `src/campaign.js:840-846` + `:162-164`

Mode `connect_and_message` returns `force_connect` on the first pass (when prevAction is empty) and `force_message` after acceptance. The OP-fallback override at line 840 only triggers when `hint === 'force_connect'` — so a `connect_and_message` campaign with `messageOpenProfiles=true` *will* upgrade the connect step into `force_connect_op_fallback`. That's probably desirable, but worth a deliberate decision: a lead messaged via OP on the first pass will then be returned `op_message_sent` and `prevAction` becomes that value. On the next campaign run, `getModeHint('connect_and_message', 'op_message_sent')` returns `force_connect` (since it only special-cases `'connection_sent'`), so we'd attempt Connect again on a lead that's already been messaged. Combined with H-04 above, this can produce duplicate touches.

**Fix:** treat `op_message_sent` as a "first-pass complete" signal:

```js
if (mode === 'connect_and_message') {
  return (prevAction === 'connection_sent' || prevAction === 'op_message_sent')
    ? 'force_message'
    : 'force_connect';
}
```

---

### M-02: Sales-Nav fallback path skips early `Already connected` check
**File:** `src/linkedin/outreach.js:266-309`

In `force_connect_op_fallback`, when the URL is already on Sales Nav (`SALES_NAV_URL_RE.test(page.url())`), we go straight to `sendViaSalesNav`. That helper has no degree-1 short-circuit, so for a lead who is already a 1st-degree connection, we will:
1. click Message
2. read panel — no "Free to Open Profile" badge (already connected → it's a normal message panel)
3. close composer
4. open the overflow menu
5. fail to find Connect ("you can't connect to a 1st-degree") → return `unreachable`

The lead is then skipped with `Sales Nav: neither OP nor Connect available`. That's misleading auditing (the lead was reachable, we just used the wrong campaign) and burns ~10-15 s of UI work.

**Fix:** before the Sales-Nav delegation in this branch, do a Voyager degree check (`getVoyagerDegree(page)`) — if degree=1, return `{ action: 'skipped', error: 'Already connected' }` immediately, mirroring the `force_connect` branch at outreach.js:200-203. Same applies symmetrically to the `/in/` branch at line 285+ but Voyager works there natively.

---

### M-03: `closeSalesNavComposer` selector is fragile + no verification
**File:** `src/linkedin/actions.js:1520-1533`

The primary selector `button[aria-label*="Close" i][class*="_close_"]` depends on a hashed CSS-module class containing `_close_`. The fallback scans `#message-overlay` / `[data-sn-view-name="subpage-message-overlay"]` for any `aria-label*="close"`. If either selector misses (LinkedIn renames the hash, removes the data attribute), the composer stays open and **the subsequent overflow-menu click will be obscured** — the helper returns silently (no return value, no thrown error), so the caller proceeds to `clickSalesNavOverflowMenu` and likely fails with `unreachable`.

**Fix:** (a) make `closeSalesNavComposer` return a boolean and verify the panel is gone (poll for absence of `[data-sn-view-name="subpage-message-overlay"]` for ~2 s); (b) if close failed, also try `Escape` key via `page.keyboard.press('Escape')` as a last resort.

---

### M-04: `clickSalesNavMessageButton` matches *any* button containing "message" → can hit nav bar
**File:** `src/linkedin/actions.js:1255-1268`

```js
if ((t === 'message' || aria.startsWith('message') || aria.includes('message')) && b.offsetWidth > 0) {
```

`aria.includes('message')` matches the top-nav "Messaging" button (aria-label="Messaging"), the "1 new message" notification, etc. Because the loop iterates DOM order and `<button>` elements in the chrome typically render before profile-action buttons, the helper can click the wrong button — opening the floating bubble bar instead of the Sales-Nav profile message panel. This is hard to spot because the next `readSalesNavComposerState` will then return `hasCompose=false` and we early-bail with `no_compose_textbox` — looks like a Sales-Nav UI glitch but is actually a wrong-target click.

**Fix:** scope the search to the lead-actions area (e.g. `[data-x--lead-actions-bar]`, `.lead-actions-bar`, or the action bar that contains a "Save" button), and reject buttons inside `nav, header, [role="navigation"]` (mirrors the guard already used in helpers.js:331).

---

### M-05: `state.processed` not cleared when `op_message_sent` happens via Connect-mode override
**File:** `src/campaign.js:937-943, :547-552`

For `mode === 'connect_only'`, the pre-filter at line 549-550 rejects the row if `state.processed[url]` exists at all — *regardless of action value*. After an OP-fallback run we save `state.processed[url] = { …, action: 'op_message_sent' }`. Good. But the next time a *fresh* Connect campaign runs (e.g. operator clears the sheet's CC/OP columns to retry), the lead is silently skipped because `state.processed[url]` is still populated. Operators have hit the "I cleared the sheet but nothing reprocessed" trap before (cf. user feedback).

**Fix:** loosen the connect_only pre-filter to consider the saved action:

```js
if (mode === 'connect_only') {
  if (cc) return false;
  const prev = state.processed[url];
  if (prev && prev.action !== 'connection_sent' && prev.action !== 'op_message_sent') return false;
  // If both CC and OP are blank in the sheet, treat as fresh and let it through
  if (prev && !cc && !opCell) return true;
  if (prev) return false;
  return true;
}
```

Or, cleaner: when the operator manually clears tracking columns, also clear `state.processed[url]` (out of scope for this review, but worth noting).

---

## Low

### L-01: `randomDelay` import in outreach.js is unused
**File:** `src/linkedin/outreach.js:11`

```js
import { randomDelay, getConnectionStatus, getVoyagerDegree, personalizeTemplate } from './helpers.js';
```

`randomDelay` is never called inside `outreach.js`. Cosmetic dead code.

**Fix:** remove `randomDelay` from the import list.

---

### L-02: `sendInMail` and `sendViaSalesNav` duplicate the `panel.creditsAvailable` decrement logic
**File:** `src/linkedin/actions.js:1237` and `:1394`

Both paths compute `creditsLeft = panel.creditsAvailable !== null ? Math.max(0, panel.creditsAvailable - 1) : null;` after a successful send. If LinkedIn ever changes the credit-counter regex (or A/B-tests a new layout), both call sites silently start returning `creditsLeft: null` and the campaign would happily keep sending until 0. Worth extracting to a shared helper and adding a unit test against a captured DOM snapshot.

**Fix:** factor out, and consider re-reading the credit counter *after* the send (Sales Nav re-renders it) for ground truth instead of arithmetic.

---

### L-03: `personalizeTemplate` strips `{placeholders}` containing spaces — could mask bad templates
**File:** `src/linkedin/helpers.js:371`

```js
return result.replace(/\{[a-zA-Z0-9_ ]+\}/g, '').trim();
```

The fallback strips any unmatched placeholder. Good for safety, bad for visibility — a template author who mis-spells `{frstName}` will quietly send a message with a hole where the name should be (e.g. `"Hi , I noticed…"`). Not a bug per se, but operators have asked for "why is the message blank" before. Consider logging when stripping non-empty unresolved tokens.

---

## Info

### I-01: Hidden assumption — LinkedIn aria-label "Invite {firstName} to connect"
**File:** `src/linkedin/actions.js:521-529` (also helpers.js:520, :707)

The Connect button discovery relies on `aria-label*="Invite"` AND `aria-label*="to connect"` AND `aria-label.includes(firstName)`. If LinkedIn changes the aria template (drops the name, switches to "Connect with {name}", or A/B-tests a generic "Invite to connect"), `firstName-includes` matching falls through to METHOD 2 (`a[href*="custom-invite"]`) — a separate fragile assumption. Worth a unit test that snapshots the current aria templates from a sample of profile DOMs so regressions surface early. (Out of v1 scope to fix; flagging the assumption.)

### I-02: `readSalesNavComposerState` regex is locale-dependent
**File:** `src/linkedin/actions.js:1273, :1279, :1280`

```js
const isFree = /free message/i.test(text);
const isFreeToOpenProfile = /free to open profile/i.test(text);
const creditMatch = text.match(/Use\s+\d+\s+of\s+(\d+)\s+credits?/i);
```

These English-only patterns will silently fail (return `false` / `null`) for any account whose LinkedIn UI is in another language — a 0% match → `not_open_profile` for OP mode and `null` credits for InMail mode. The Ortus team is currently English-only so this is not actionable, but document the assumption in the file header.

### I-03: `console.log` debug statements mixed with structured logger
**File:** Throughout `outreach.js` / `actions.js`

The codebase uses both `console.log('[outreach] …')` and the campaign.js `log()` function. The `console.log` lines go to stdout but not to the dashboard's in-memory ring buffer that operators see. For the Connect/OP flows specifically, operators have asked "why did it skip" and the diagnostic line is in stderr only. Not blocking — consider either piping `console.log` into the ring buffer or using `log()` consistently.

---

## Cross-cutting observations

1. **No detected race condition** in the Connect/OP paths. The campaign loop is strictly sequential per profile, page handles are re-acquired after each lead (campaign.js:850-861), and `page.isClosed?.()` is checked before parking. Good.
2. **No detected divide-by-zero** — `profileIds.length` is only used in: (a) a log message, (b) a `> 3` warning, (c) a `=== 1` branch in the delay multiplier. The outer loop's `activeProfiles.length === 0` guard at line 721 handles the empty case. The pre-filter `targets.length === 0` is logged but doesn't gate the outer loop — `leadIndex < targets.length` at line 775 will simply fall through and `leadsExhausted` flips, exiting cleanly.
3. **Sheet writeback is best-effort** (`.catch(() => {})` on every `updateSheetRow`). That's intentional for resilience, but means a transient Sheets API outage during a successful Connect *will* leave the row un-stamped — and since `state.processed` is updated **before** the sheet write (line 938 vs line 1000), the next run's in-loop skip at line 814 (`cc !== 'sent'` for check_status) and pre-filter (`cc` non-empty for connect_only) will both fail to recognise the prior success. That's a known trade-off but worth a follow-up: queue retries for failed `updateSheetRow` calls or at least surface a per-row warning in the dashboard.

---

_Reviewed: 2026-04-24_
_Reviewer: Claude (manual scoped review)_
_Depth: standard, scoped to Connect campaign + OP messaging flows only_
