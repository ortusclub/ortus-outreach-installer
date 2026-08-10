# Multi-org Follower Growth — Apex Strategy

**Date:** 2026-08-10
**Status:** SUPERSEDED by `2026-08-10-follower-growth-simplification-design.md`

Superseded the same day. Sam asked for the company page to be picked from a dropdown
in setup, which removes this spec's central mechanism (resolving the org from each
account's SoO `Company`) and, with the sheet becoming a per-run input, also removes
the need for a second spreadsheet and Apps Script deployment for Apex. Kept for the
record of what was rejected and why.

## Why

Jhan (Apex) asked for access to Follower Growth. FG today can only ever grow
the Ortus Club page: the page URL is a constant, and the invite ledger is a
single Apps Script bound to one spreadsheet.

The prompt for this was an access request, but the interesting finding is that
the org axis **already exists** — SoO's `Company` column, which is how Ortus
accounts were already separated from everyone else's. 36 accounts carry
`Company = "Apex Strategy"`.

## The overriding constraint

**Ortus FG must behave identically after this change.** This is a
single-tenant system growing a second tenant, not a rewrite. Every design
decision below defaults to today's behaviour; Apex is the branch, never Ortus.
The test suite pins this explicitly (see Testing).

## What already works — no code needed

Verified 2026-08-10:

| Thing | State |
|---|---|
| Apex accounts in SoO | 36, `Company = "Apex Strategy"`, all `GoLogin (Y/N) = Y` (35 Active, 1 Inaccessible) |
| Their networks | 30 of 36 ingested — **16,282 connections** |
| Central roster (GKE) | serves them; `listFgColleaguesMatched` returns them |
| `Company` via the app | `getSoO` already returns **every** column as a raw key-value pair keyed by header name — no Apps Script change, no redeploy |

The 6 accounts with no ingested CSV (`josericardo.fajanilag`,
`eduardo.macasling`, `katrina.par`, `ayush.goswami`, `leiddy.penamora`,
`udit.pandey`) are out of scope; the first Apex run uses the 30 we have.

Note: the four `@apexstrategy.io` CSVs in `data/connections/` are Apex *staff's
own* networks and are **not** the sending accounts. They are unrelated to this
design.

## Decisions

| Question | Decision |
|---|---|
| Ambition | 2–3 known orgs. Config object, no self-serve onboarding |
| Sending accounts | Apex's own — the 36 SoO accounts |
| Ledger | Separate sheet + separate Apps Script deployment per org |
| Access isolation | None. An Apex login sees the whole app, as today |
| Org resolution | SoO `Company` column, per account |
| Runtime | Cloud VM, as Ortus does |
| Autopilot | Ortus only for now; per-org is a later phase |
| Ledger scope | Invites + Budgets. No Funnel, no Master |
| Other `Company` values | `Nabeen`, `Zai`, `Ton`, `CCG Chatham` are **not** orgs — they resolve to Ortus |

Org resolution was initially specced as login-email-domain inference. That was
wrong and is recorded here so it isn't re-proposed: Apex's senders are all
`@ortus.solutions`, so a domain rule would hand an Apex operator Ortus accounts
pointed at the Apex page.

## Design

### 1. Org registry — `src/fg-orgs.js` (new)

The single place org facts live. Adding org #3 is one object literal plus a
sheet.

```js
export const FG_ORGS = {
  ortus: {
    id: 'ortus',
    label: 'Ortus Club',
    company: null,                     // the default — matches no Company value
    inviteUrl: ORTUS_PAGE_INVITE_URL,  // unchanged constant
    webappUrl: FG_WEBAPP_URL,          // unchanged constant
    monthlyBudget: FG_DEFAULT_MONTHLY_ALLOWANCE,
  },
  apex: {
    id: 'apex',
    label: 'Apex Strategy',
    company: 'Apex Strategy',
    inviteUrl: 'https://www.linkedin.com/company/apex-guesting-partner/posts/?feedView=all&invite=true',
    webappUrl: FG_WEBAPP_URL_APEX,
    monthlyBudget: FG_DEFAULT_MONTHLY_ALLOWANCE,
  },
};

export function orgForCompany(company)  // → org config; unrecognised → ortus
export function orgById(id)             // → org config; unknown → ortus
```

`orgForCompany` matches on a trimmed, case-insensitive comparison. Anything
unrecognised resolves to Ortus — the safe default, since SoO is hand-maintained
and demonstrably contains people's first names in that column.

**Unrecognised non-empty values are logged once per run.** A typo
(`"Apex Strategy "`, `"apex strategy"` — both of which DO match — versus
`"Apex Strateg"`, which does not) must surface in the log rather than silently
writing Apex invites into Ortus's ledger.

The Apex invite URL uses the `/posts/?feedView=all&invite=true` form. That
exact shape is what is confirmed to open the invite modal (see the comment on
`ORTUS_PAGE_INVITE_URL`); the bare `/company/<slug>/` URL is not sufficient.

### 2. Org resolution

Each selected account's SoO row yields its `Company`, which yields its org.

**A selection spanning two orgs is refused**, with an error naming the
offending accounts. This is what makes a mixed-org run impossible rather than
merely discouraged — one run writes to exactly one ledger and invites to
exactly one page.

SoO is already fetched via the existing `fetchSoOData()`. A new helper indexes
`email → Company` from that same payload; no extra network call, no new
credentials.

### 3. Threading the org through

Two kinds of change.

**The page URL.** Four sites hardcode `ORTUS_PAGE_INVITE_URL` and become
org-resolved:

- `server.js:2700` — local single-account send
- `server.js:3117` — team launch campaign config
- `server.js:3167` — team launch cloud dispatch
- `server.js:3215` — the `runFollowerInvites` send call

The cloud FG launch path (`server.js:1459`) already accepts `body.inviteUrl`
and needs no change — it only needs the caller to pass the org's URL.

**The ledger URL.** `src/connections/fg-sync.js` imports `FG_WEBAPP_URL` at
module load, so every ledger write is bound to Ortus's sheet at import time.
This becomes a per-call `webappUrl` threaded from the org — roughly ten call
sites. Mechanical, but it touches every FG write path, which is why the Ortus
regression tests below matter more than usual.

### 4. Operator picker — unchanged

The picker is **not** filtered by org, and `server.js` needs no change here.

Two reasons. First, the org is *derived from* the selection (§2), so filtering
the list by org before a selection exists is circular. Second, filtering the
Ortus picker to "not Apex" would remove 30 options an operator can pick today —
a change to Ortus behaviour, which the overriding constraint forbids.

So the operator picks accounts exactly as now; the org falls out of what they
picked, and the mixed-org refusal is the only guard needed. An Ortus staffer
selecting only Apex accounts therefore runs a legitimate Apex campaign — which
is correct under the "trusted, full access" decision, and is how you would run
Apex FG on Jhan's behalf.

### 5. Apex ledger

A new spreadsheet plus a **second deployment of `fg-apps-script.js`, code
unchanged**. The script creates tabs on demand, so FG Invites and FG Budgets
appear on first write and Funnel/Master simply never get touched. Antonio owns
the deployment; its `/exec` URL becomes `FG_WEBAPP_URL_APEX`.

This is why "separate sheet + separate deployment" beat "one sheet with an Org
column": no schema change, no filtering logic to get wrong, and no path by
which an Apex write can land in Ortus's ledger.

## Ortus safety

The regression risk is concentrated in `fg-sync.js`, where every write path
changes shape. Three defences:

1. **The Ortus org config holds the existing constants verbatim.** Not copies,
   not re-derived values — the same `ORTUS_PAGE_INVITE_URL` and
   `FG_WEBAPP_URL` imports.
2. **Every unrecognised input resolves to Ortus.** Empty `Company`, missing SoO
   row, unknown org id, absent registry entry — all land on today's behaviour.
3. **Tests assert the resolved values equal the constants**, so a future edit
   to the registry that changes Ortus's page or sheet fails the suite.

## Testing

`node --test`, pure-helper style, matching the repo's convention.

- `orgForCompany`: `'Apex Strategy'`, `'apex strategy'`, `' Apex Strategy '` →
  apex; `''`, `null`, `'Nabeen'`, `'Zai'`, `'Ton'`, `'CCG Chatham'`,
  `'The Ortus Club'` → ortus.
- **Ortus regression:** `orgForCompany(anything-not-apex).inviteUrl ===
  ORTUS_PAGE_INVITE_URL` and `.webappUrl === FG_WEBAPP_URL`. This is the test
  that fails if someone breaks Ortus.
- Mixed-org selection is refused, and the error names the offending accounts.
- A single-org selection resolves to exactly one `inviteUrl` + `webappUrl`.
- Unrecognised non-empty `Company` values are reported, not swallowed.

## Out of scope

- Access isolation — an Apex login sees the whole app, per decision.
- Self-serve org onboarding.
- Per-org Autopilot; the 1st & 15th cron stays Ortus-only.
- Funnel and Master tabs for Apex.
- Ingesting the 6 missing Apex networks.
- The other `Company` values.

## Open items — do not block the build

1. Antonio creates the Apex spreadsheet and deploys `fg-apps-script.js` to it;
   the `/exec` URL fills `FG_WEBAPP_URL_APEX`. Blocks the first Apex run, not
   the implementation.
2. Confirm with Apex that all 36 accounts are approved to invite from.

## Files touched

| File | Change |
|---|---|
| `src/fg-orgs.js` | new — registry + resolution |
| `src/sheets-webapp-url.js` | add `FG_WEBAPP_URL_APEX` |
| `src/connections/fg-sync.js` | `webappUrl` per call instead of module-bound |
| `server.js` | 4 invite-URL sites + org resolution + mixed-org refusal |
| `tests/fg-orgs.test.js` | new |
