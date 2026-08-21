# Logging inventory: everything the app knows and does not show

Date: 2026-08-21. Read of `src/campaign.js`, `src/linkedin/outreach.js`,
`src/linkedin/actions.js`, `src/linkedin/auto-intro.js`, `src/sheets-writer.js`,
`src/resource-monitor.js`, `server.js`.

Purpose: before building the per-account step panel, establish what the code
already computes, where each fact goes today, and what is lost. Every number and
string on the sketch has to come from this list, or it is invented.

## The three destinations, and why one of them is a dead end

| Destination | Reaches the operator | Survives a restart |
|---|---|---|
| `log()` → `campaign.logs` | Yes, Live Log on the card | No (in-memory, ~500 lines) |
| `console.log()` → stdout | **No.** `/tmp/dev-app.log` only | No |
| Sheet columns (Stage / Status / audit) | Yes, but only by opening the sheet | Yes |

**The gap.** 222 `log()` calls in `campaign.js` reach the card. 30 in
`outreach.js` and 91 in `actions.js` are `console.log` and reach nobody. The
whole bulk-check diagnostic is in the second group, which is why a sweep that
ran, opened three browsers and sent intro DMs produced a card that read
"nothing running right now".

## 1. Why a lead was not hit — `normalizeSkipReason()` (campaign.js:431-478)

The canonical taxonomy. Every failure funnels through here and is written to the
sheet's Stage column as `Skipped: <reason>`. **The card never shows it.** 22
distinct reasons:

- Legacy Sales Nav URL
- Profile not found (404)
- URL not found
- Session expired
- Email required
- Connect button not found
- Connect modal opened for wrong person
- Send not confirmed
- Rate-limited (HTTP 429) — confirming…
- LinkedIn rejected (HTTP `<status>`)
- Profile not premium, custom notes limit
- Weekly limit reached
- InMail credits exhausted
- Not yet connected
- Not confirmed connected
- LinkedIn error toast
- Not Open Profile
- Rate limited
- Lead timed out
- Connect modal did not appear
- Connect failed
- `Skipped: <raw>` fallback for anything unrecognised

Pass-through (not skips): Connection sent, Message sent, InMail sent, Open
Profile message sent, Acceptance confirmed, sent IC, Already in target state,
Already connected, Still pending.

## 2. Why an account stopped — `recordProfileEnd()` (campaign.js:905)

First reason wins, so a weekly-limit park is never overwritten by a downstream
trip-wire. 15 call sites:

- Session expired — log in again (×2 sites)
- Check Status complete (bulk)
- Parked after N consecutive identity-unverified leads
- No InMail credits left (×2)
- InMail credits exhausted
- Reached campaign limit (`dailyLimit`)
- LinkedIn checkpoint — needs a human
- Paused — LinkedIn throttling (resumes next run)
- Weekly invitation limit reached (`HTTP_429_PARK_THRESHOLD`× HTTP 429)
- Parked after N consecutive skips
- Weekly invitation limit hit (~100/week)
- Out of note credits
- Not Premium — custom note over 200-char limit

Surfaced today only in the end-of-run history payload
(`profileEndReasons`), not live on the card while it is happening.

## 3. Why the run ended — `endReason` (campaign.js:2062, 5095-5135)

`completed` · `errored` · `stopped`, mapped for display to `error` ·
`operator_stopped` · `all_parked` (with the parked list as detail) ·
`no_more_rows`.

## 4. The batch counter that already exists

`campaign.js:4180`:

```js
log(`  ✓ [${pName}] (${getCampaignCount(profileId)}/${campaign.dailyLimit})`);
```

This is the `19/100` on the sketch, verbatim. It is emitted on every successful
send and buried in a log line. The card shows a campaign-wide percentage and
never the per-account count, so an operator cannot see that one account is at
its cap while another has barely started.

## 5. Pre-filter — leads dropped before the run (campaign.js:2380-2606)

```
log(`Pre-filter → ${targets.length} to process, ${_pfRows.length - targets.length} skipped (mode: ${mode})`);
```

One line, one number, no breakdown. The rules that produced it:

- **Stage schema** (`Stage` column present) is the single source of truth.
  Terminal Stages: `DM Sent`, `IC Sent`, `InM Sent`, `OP Sent`, `Replied`,
  `Done`, and anything starting with `Skipped`.
- `check_status`: only `Connect Pending` rows.
- `introduce_back`: any non-empty `Intro Status` is terminal, including operator
  notes and `Failed — …`.
- `message_only`: `DM Sent` is terminal.
- Blank / unparseable LinkedIn URL: dropped silently.
- `allLeadsConnected` bypasses the Stage gate for IC and DM.

Field report already on record (comment at `campaign.js:3442`): an operator saw
`Pre-filter → 431 to process` and had no way to learn why the other rows were
dropped.

## 6. Bulk check / acceptance sweep — the diag line

`[bulk-check] diag:` counters, `console.log` only, so **card-invisible**:

`scanned` · `withUrl` · `slugs` · `memberIds` · `names` · `pidMatched` ·
`alreadyConnected` · `alreadyIntroduced` · `crossSender` · `duplicateCollapsed` ·
`alreadyDmd` · `requestHealed` · `alreadyUnverified` · `composeCapped` ·
`alreadyDeclined` · `stamped`

These answer "the check ran and stamped nothing, why". Measured today:
`scanned=66, withUrl=0, slugs=379, memberIds=381, pidMatched=0, stamped=0` —
`withUrl=0` and `pidMatched=0` together say the sheet rows and the LinkedIn
invitations never matched on any axis, which is a diagnosable condition the
operator was never shown.

Per-account lines that DO reach the card: `✓ [name] Bulk: N Connected, M Still
Pending (of F fetched)`, `⚠ [name] Bulk check: <error>`, `⚠ [name] Bulk check
threw: <msg>`.

## 7. Intro DM failures — `auto-intro.js:308-346`

Written to Introduction Status as `Failed — <reason>`, and only there:

- Compose page didn't load
- Primary name didn't match suggestions
- Compose page missing recipient field
- Primary clicked but not added
- Compose page froze
- Invalid lead URL
- Couldn't type message
- Message body not focusable
- Send not confirmed
- Primary name missing in template

Plus the no-op decisions `cc-not-connected`, `genuine-1st-degree`,
`follow-only-restricted`, `ambiguous`, and the reverify / downgrade lines.

## 8. Identity gate (campaign.js:640-740)

`profile_not_found_404` · `identity-gate-disabled` · `not-attempted` · retry
attempts with `✓ identity confirmed on attempt N (<reason>)`. Feeds the
`Parked after N consecutive identity-unverified leads` account park. This is the
step that prevents sending to the wrong person, so it earns its own row in the
panel.

## 9. Throttle and resource pressure (campaign.js:3388-3396)

`⚠ Throttle ENGAGED: <reason> — delays now Nx` / `✓ Throttle RELEASED`.
`campaign._throttle = { active, reason, multiplier }` is on the status payload
and shown nowhere on the card.

## 10. Sheet writes (sheets-writer.js)

`transient write error (attempt N/M): <error> — retrying`, and
`✓ X/Y row(s) updated … — Z not found`. The "not found" count means a lead was
processed but its sheet row was never stamped, which is exactly how a lead gets
re-sent on the next run. `console.log` only. `sheetWriteFailures` IS on the
status payload and does have a warning component (`renderSheetWriteWarn`).

## 11. Session / login (campaign.js:1382-1516)

`re-logged in — resuming` · `login not completed within 5 min — parking
account` · `login timed out after 120s` · `session expired — parking profile for
rest of run` · `cache cleared` / `cache clear skipped`.

## 12. Ops log (`_ops`) → central Ortus Operations Log sheet

Separate destination, fire-and-forget, `OPS_LOG_WEBAPP_URL`. Not operator-facing
on the card. Out of scope here, noted so it is not double-plumbed.

---

## What this means for the build

1. **A stream tag is required.** The log lines need `CHECK / SEND / SHEET /
   VOYAGER / MATCH / IDENTITY / SESSION / THROTTLE / ERROR` so the filter chips
   are real and not cosmetic.
2. **A `where` tag is required.** `MAC` or `VM`, so a handed-over campaign's two
   halves read as one story.
3. **The biggest single win is not new logging, it is promoting `console.log`
   to `log()`** in the bulk-check and outreach paths. The facts already exist.
4. **Skip reasons must be kept per account**, not only written to the sheet, so
   the panel's "Not hit, and why" has a source.
5. **Pre-filter needs a breakdown**, not a total, or "why only 47 of 300" stays
   unanswerable on the card.
6. `src/linkedin/outreach.js` and `src/linkedin/actions.js` are off-limits
   without an explicit instruction. Any promotion of their `console.log` calls
   must be requested first, or the taxonomy has to be captured at the
   `campaign.js` call boundary instead.
