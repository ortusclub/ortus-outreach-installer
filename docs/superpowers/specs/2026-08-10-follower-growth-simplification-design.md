# Follower Growth — point it at a sheet, pick a page

**Date:** 2026-08-10
**Status:** Approved, not yet implemented
**Supersedes:** `2026-08-10-multi-org-follower-growth-design.md` (org resolution by SoO
`Company` is dropped — Sam asked for an explicit dropdown instead)

## Why

Sam, verbatim:

> "What I wanted to do is keep it very simple where it's offline outside the app in a
> sheet. Create the lists where we want to make the introductions and then just point
> the app at the sheet. None of this review or create or build."

and

> "Why is it creating the tab, why can't I just give it a tab. Like the CC campaign or
> message campaign, I just point the app at the tab. It then creates additional columns,
> but it doesn't create a tab."

He is right, and the second quote names the exact asymmetry.

**A CC campaign's sheet is an INPUT.** You paste any spreadsheet URL, `fetchSheet(url)`
reads the chosen gid, `updateSheetRow` stamps result columns back into your tab.

**FG's sheet is an OUTPUT.** It is bound to the one central FG spreadsheet through an
Apps Script (`postFg`), so it can only address tabs *by name inside that sheet*. To
accept a list it has to write one first. The existing "bring your own tab" option only
picks from tabs already living in the app's sheet — not from yours.

Nothing technical forces this. `parseListRows` (`src/connections/fg-list.js`) is already
header-tolerant and needs only **LinkedIn URL** and **Account Email**.

Sam also asked, separately:

> "And ideally be able to select different company pages" … "Choose in the setup from a
> dropdown."

That settles a question the superseded spec got wrong: the page is picked explicitly, not
inferred from the login email or from the accounts selected.

## Why his last attempt "built me new lists"

He did use the bring-your-own path. Three reasons it didn't hold:

1. **Silent fallback.** `fgtlLaunch` (`public/js/app.js`):
   ```js
   const listPayload = _fgtlListTab ? { source: 'list', tab: _fgtlListTab } : {};
   ```
   No tab set → no `source` → the server drops into the legacy `buildFgTargets` branch and
   builds a fresh list. No warning.
2. **`_fgtlListTab` is an in-memory variable.** Reload or restart and it is gone; it is
   only restored if a *previous cloud run* exists. Pick a tab, reload, launch → regenerate.
3. **He could not use his own sheet at all** — only a tab inside the app's central sheet.

Fixing (3) makes (1) and (2) mostly moot, but all three are addressed below.

## Design

### 1. The sheet is an input

Replace the two Apps-Script-bound calls on the fire path with the primitives CC already
uses:

| Today | Becomes |
|---|---|
| `readFgList(tab)` — Apps Script, central sheet | `fetchSheet(sheetUrl)` |
| ledger writeback via `postFg` into the named tab | `updateSheetRow(sheetUrl, url, data, linkedinColumn)` |

Both are already imported in `server.js`. The reconcile loop stamps **Status**, **Invited
At**, **Note**, **Member ID** into the operator's own tab, adding columns where they are
missing and touching nothing else — the CC behaviour Sam described.

`parseListRows` is unchanged. It already tolerates arbitrary column order and spellings via
`HEADER_ALIASES`, and only **LinkedIn URL** + **Account Email** are required.

### 2. Two doors, chosen before anything happens

Step 2 of the wizard offers exactly two options, one of which must be picked:

- **I already have the list** — paste a Google Sheet URL (with `#gid=`), same control as a
  CC campaign: Preview, Open sheet, tab picker when the workbook has several.
- **Build one for me** — today's roles-and-connections builder. It writes a sheet and hands
  its URL back to the box above, so downstream there is only ever one path: a sheet URL.

**No fallback.** If no source is set, the run is refused with a message. The app never
builds a list that was not explicitly asked for. This is the fix for Sam's core complaint,
and it is a deletion, not a feature.

The chosen sheet URL is **persisted** (localStorage, as elsewhere in the app), so a reload
cannot silently change what fires.

### 3. Company page is a dropdown

New step 1. A `<select>` naming the page every invite goes to:

```js
export const FG_PAGES = {
  ortus: { id: 'ortus', label: 'Ortus Club', inviteUrl: ORTUS_PAGE_INVITE_URL },
  apex:  { id: 'apex',  label: 'Apex Guesting Partner',
           inviteUrl: 'https://www.linkedin.com/company/apex-guesting-partner/posts/?feedView=all&invite=true' },
};
```

Ortus is the first option and the default, so doing nothing behaves exactly as today.

The `/posts/?feedView=all&invite=true` shape is required — it is what actually opens the
invite modal (see the comment on `ORTUS_PAGE_INVITE_URL`). A bare `/company/<slug>/` URL
does not.

Everyone sees every page. Sam accepted this explicitly when told "everyone can action it
and see it".

Adding a third page is one object literal.

### 4. The page is stamped on the run

The dropdown makes possible something inference hid: an Ortus account pointed at the Apex
page, or the reverse. Nothing blocks it — Sam wants the freedom — but a wrong pick must be
visible in seconds, not after 400 invites.

So the chosen page's label is carried on the campaign config and shown in three places:

- the Live status card eyebrow,
- the first line of the campaign log,
- the confirm dialog on **Run it now**.

No validation, no coupling to which accounts were selected. Visibility only.

### 5. Live status is untouched

The Live status section, the streaming log, the per-account board, the `vj-card` (progress
bar, launch banner, hero stats, live log, batch summary) and the FG Master collapsible keep
their current markup, classes and behaviour. The only edit is the step number on the badge
and the page label in the eyebrow.

This is explicit: the card works, operators know it, and it is not part of the complaint.

### 6. What the de-dupe ledger does

The central **FG Invites** tab is what stops re-inviting someone, and it stays central and
unchanged — `markFgInvited` still writes to it after every run. Only the *list* comes from
the operator's sheet.

This is the one part that cannot be fully offline: a per-run sheet has no memory of what
other runs invited. Flagged to Sam.

Consequence for Apex: it needs **no second spreadsheet and no second Apps Script
deployment**. The superseded spec required both.

## Files touched

| File | Change |
|---|---|
| `src/fg-pages.js` | new — `FG_PAGES` + `pageById()` (unknown id → ortus) |
| `server.js` | `source:'list'` branch reads `fetchSheet(sheetUrl)`; writeback via `updateSheetRow`; refuse when no source; page from the request, not the constant |
| `public/js/app.js` | two-door picker, sheet-URL field, persistence, page dropdown, no fallback |
| `public/index.html` | step 1 page dropdown, step 2 two doors; roles chips / "Write the list to the sheet" / review gate removed |
| `src/connections/fg-list-launch.js` | `dispatchFromRows` takes the page's `inviteUrl` |
| `tests/fg-pages.test.js` | new |

`readFgList` / `writeFgList` stay for the builder door, which still writes a sheet.

## Testing

`node --test`, pure-helper style, matching the repo's convention.

- `pageById('ortus').inviteUrl === ORTUS_PAGE_INVITE_URL`; `pageById('apex')` is the Apex
  URL; `pageById('')`, `pageById('nonsense')`, `pageById(undefined)` all → ortus.
- **Ortus regression:** the default page resolves to exactly today's constant. This is the
  test that fails if someone breaks Ortus.
- `parseListRows` accepts a sheet with only **LinkedIn URL** and **Account Email**, in any
  column order, with alias spellings.
- A launch with no source is refused, and the error says so — it does not build a list.
- An unknown Account Email is reported per row, not silently dropped.

## Out of scope

- Access isolation — every operator sees every page, per Sam.
- Per-page Auto-Pilot schedules; the 1st & 15th cron stays as it is.
- Moving the FG Invites ledger out of the central sheet.
- Ingesting the 6 Apex networks with no CSV.

## Open items — do not block the build

1. Confirm with Apex that all 36 accounts are approved to invite from.
2. Confirm the Apex page slug `apex-guesting-partner` opens the invite modal for an
   account with admin rights on it.
