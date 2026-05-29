# Spec — "Recent Connections" tab as the matching Bible

**Date:** 2026-05-28
**Status:** Draft for review
**Branch:** `connection-check-review`
**Related review:** `REVIEW-connection-check.md` (Findings A & B)

---

## Problem

Connection detection keeps "breaking" — a lead who genuinely accepted shows back
up as "Still Pending," or an acceptance is never detected at all. Two root causes,
both documented in `REVIEW-connection-check.md`:

1. **The matcher reads an ephemeral list, not a durable record.** Matching runs
   against the *live* Voyager fetch, which LinkedIn caps at the **80 most-recent
   connections** (`helpers.js:148`). Anyone who accepted before the 80 newest
   connections has silently fallen off the list.
2. **The "Recent Connections" tab is a snapshot, not a ledger, and is never read
   back.** Each sweep **deletes** the account's rows and rewrites them from the
   latest 80 (`google-apps-script.js:1434-1463`), so the tab forgets people just
   as fast as the live list does. And no code path ever reads the tab for
   matching — it's a write-only audit dump.

The operator's intent: the tab should be **the Bible** — the authoritative record
of who is connected to whom for the current campaign.

## Goal

Make the "Recent Connections" tab the **source of truth** for connection matching,
scoped to the current campaign and its senders, accumulating as the campaign runs
so nobody falls off LinkedIn's 80-connection window.

## Non-goals

- Not a cross-campaign, forever archive. The tab is **per-campaign** and is wiped
  clean when a campaign starts.
- No changes to `src/linkedin/outreach.js` or `src/linkedin/actions.js` (off-limits).
- No change to the per-lead degree-badge check (`outreach.js`) that `check_status`
  falls back to when the Voyager fetch errors entirely.

---

## The model (agreed)

1. **Campaign start → tab wiped clean.** Empty slate every new campaign run.
   (Resume does **not** wipe — see Data Flow.)
2. **Each sweep → append-only, deduped, sender-scoped.** Pull the live ≤80, drop
   rows from accounts not sending in this campaign, and **append only people not
   already in the tab** for that account. Never delete an account's existing rows.
3. **Matching reads the accumulated tab**, not the live 80:
   - In the tab **under the row's assigned Sender** → **Connected**.
   - In the tab **under a different campaign sender** → **"Already connected to
     [that account]"** (informational; no Connected stamp, no DM/intro fired).
   - **Not in the tab** at all → not connected (→ "Still Pending" if the bot
     invited; otherwise left alone).

**Dedupe identity** (per account): LinkedIn URN (`ACoAA…` member ID) → `/in/` slug
(`publicId`) → `firstName lastName`, in that priority. Same person under the same
account collapses to one row; the same person under two different campaign senders
is two legitimate rows (one per account).

---

## Architecture

The Apps Script (Sheet side) owns accumulation. One round-trip per sweep does the
write **and** returns the accumulated set, so the tab is literally the match source.

### Component changes

| File | Change |
|------|--------|
| `google-apps-script.js` | (a) New `clearRecentConnections` action — empties the tab (keeps header). (b) `handleWriteRecentConnections` switches from delete-and-rewrite to **append-only-deduped**, keeps active-sender scoping, and **returns the full accumulated scoped set** in its JSON response. |
| `src/sheets-writer.js` | `writeRecentConnectionsTab` returns the accumulated set from the response (today it returns a bare `true`/`false`). New `clearRecentConnectionsTab(sheetUrl)` wrapper for the clear action. |
| `src/linkedin/bulk-check-connections.js` | `bulkCheckConnections` passes the **accumulated set** (not the live `conns`) into `computeBulkCheckUpdates`. `computeBulkCheckUpdates` matches against tab rows and derives Connected vs "Already connected to [account]" from each tab row's `Account` field. |
| `src/campaign.js` | Call `clearRecentConnectionsTab(sheetUrl)` once at campaign start, **only when `!resumeContext`**. |

### Data flow — one sweep

```
1. getRecentConnections(page, 0)            → live ≤80 connections (or .error)
2. writeRecentConnectionsTab(url, sender, fetched, activeSenders)
     └─ Apps Script: drop non-active-sender rows
                     append only NEW (deduped) rows for `sender`
                     return { ok, accumulated: [ {account, publicId, urn,
                                                  memberId, firstName, lastName} ] }
3. computeBulkCheckUpdates(rows, accumulated, …)   ← matches against the TAB set
4. batchUpdateSheet(updates)  +  phase-2 dispatch on connectedUrls (CC+IC / CC+DM)
```

### Campaign start

```
startCampaign(...) {
  if (!resumeContext) await clearRecentConnectionsTab(sheetUrl);   // wipe once
  …existing loop…
}
```

Resume keeps the tab so an interrupted campaign doesn't lose its accumulated record.

---

## Matching logic (`computeBulkCheckUpdates`, revised)

Input changes from `conns` (live fetch objects) to `tabRows` (accumulated set, each
carrying an `account`). Build the match sets **with account attribution**:

- `bySlug: Map<slug, Set<account>>`
- `byMemberId: Map<memberId, Set<account>>`
- `byName: Map<name, Set<account>>`

For each sheet row:
1. Resolve the row's **assigned sender** from the `Sender` column (normalized).
2. Look the lead up by slug → memberId → name. Collect the set of `account`s that
   have this person in the tab.
3. Decide:
   - **No accounts** → not connected. If `requestStatus === 'Connection Request
     Sent'` and not sender-mismatched → stamp `Still Pending (<ts>)`. (Existing
     "never downgrade Connected/Already connected/Introduced" guards retained as
     belt-and-suspenders — with an accumulating tab they should rarely fire.)
   - **Assigned sender is among the accounts** → **Connected.** Preserve the
     existing `wasInvited` split: `Connection Request Sent` → `cc='Connected'`,
     `stage='Connected'`; otherwise pre-existing → `'Already connected'` block.
     Push to `connectedUrls` for phase-2 (CC+IC intro / CC+DM message).
   - **Only other campaign senders have them** → informational
     `stage='Already connected to <thatAccount>'`. No `cc`, no `connectedUrls`,
     no Stage overwrite if already Connected (existing cross-sender branch
     behavior, now driven by tab data instead of the calling profile name).

This makes the three operator rules fall directly out of the tab's `Account`
column, replacing the current reliance on "which profile is running the sweep."

---

## Error handling & fallback

- **Voyager fetch fails** (`conns.error`): unchanged — sweep returns the error;
  `check_status` mode still falls through to the per-lead degree-badge path.
- **Apps Script write/return fails:** degrade gracefully — if the accumulated set
  can't be retrieved, fall back to matching against the live `conns` for that
  sweep (preserves today's behavior so a sweep is never a hard failure). Logged.
- **`clearRecentConnections` fails at campaign start:** non-fatal, logged
  prominently. Active-sender scoping still prevents foreign-account false
  positives; worst case is stale rows from a prior same-sender campaign on the
  same sheet, which still represent real connections to those accounts.
- **Empty tab on first sweep:** expected. First sweep populates it; matching that
  sweep uses the set returned *after* the append, so newly-fetched people are
  matched in the same pass.

---

## Testing

- **`computeBulkCheckUpdates` (pure, `node --test`)** — primary coverage. New/updated
  cases:
  - Lead in tab under assigned sender → Connected (+ `wasInvited` split).
  - Lead in tab under a different campaign sender only → "Already connected to
    [account]", no `connectedUrls`, no `cc`.
  - Lead in tab under both assigned sender and another → Connected (assigned wins).
  - Lead not in tab, invited → Still Pending.
  - Dedupe-equivalent inputs (same person via slug vs URN) resolve to one match.
  - Sticky `Unverified — manual review` and `Introduction Made` guards still skip.
- **Apps Script append-dedupe** — extract the dedupe/merge into a small pure
  function within `google-apps-script.js` and mirror its logic in a Node unit test
  where practical; otherwise manual verification on a scratch sheet (GAS has no test
  harness in this repo). Verify: clean-on-start, append-not-replace, no duplicates,
  non-active-sender rows dropped.
- **Manual end-to-end** — run a CC+IC campaign with two senders on a scratch sheet;
  confirm the tab starts empty, fills incrementally, never duplicates, and that
  acceptances older than 80 connections stay Connected across sweeps.

---

## Open questions

1. Should the accumulated set returned by Apps Script be capped (e.g. a few
   thousand rows) to bound the response size on very large campaigns, or is the
   per-campaign scope small enough to ignore? (Lean: ignore for now — YAGNI.)
2. When the same lead is connected to two campaign senders, "Already connected to
   [account]" currently names one account. If multiple, name the first or list
   all? (Lean: name the assigned-sender match as Connected; the multi-other case
   is rare — name the first other account.)
