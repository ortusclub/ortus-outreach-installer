# Pre-flight Lead-Sheet Linter + Company Blocklist — Design

**Date:** 2026-07-07
**Status:** Approved by Antonio (chat, 07.07.2026) — Wave 1 ① of the campaign-improvements plan
**Approved UI reference:** `public/sketches/preflight-linter-B.html`, `public/sketches/company-blocklist-A.html`, `public/sketches/master-all-features.html` (linter overlay + blocklist panel; these sketches are the visual contract)

## Problem

Campaigns launch with zero validation of the lead sheet. Real incidents this causes:

- **Wrong-person sends** — sheet rows pairing one person's name with another person's URL (row 413: First Name "Lavanya Vemula" + `linkedin.com/in/leonkatsnelson`). The app faithfully sends "Hi Lavanya" to Leon Katsnelson. Root-caused 06.07.2026; the send path is mechanically correct, the data is wrong.
- **Wrong-tab reads** — a sheet URL without `#gid` silently reads the FIRST tab (`sheets.js:~144` is a console.warn only).
- **Column typos** — a wrong `linkedinColumn` name fails only at the first send, mid-run.
- **Broken personalization** — `{company}` on an empty cell renders "Hello Alice from " (found only if the operator previews the right rows).
- **Politically expensive sends** — cold-connecting employees of existing clients, sponsors, or Ortus itself (Dion-type incidents). Nothing prevents this today.
- **Duplicate rows** — byte-identical adjacent URLs (rows 109/110 case) get multiple guards downstream, but nothing flags them at launch.

## Goal

A hard gate between the Start click and the actual launch: scan every target row, show findings grouped ❌ Blockers / ⚠ Warnings / ✓ Passed, and let the operator fix, exclude, or (for non-blocklist findings) consciously override — before any browser opens.

## Decisions made

| Decision | Choice | Rationale |
|---|---|---|
| Blocklist storage | **Local file per app** (`data/blocklist.json`) | Antonio's pick. No Apps Script redeploy; can graduate to a shared sheet tab later. |
| Excluded rows | **Stamped on the sheet** (`Skipped: blocklist — <entry>` / `Skipped: name≠URL` in the Stage column) | Antonio's pick. Visible to all operators; terminal Stage value means no future run re-sends. |
| Blocklist override | **None.** No "launch anyway" for blocklist matches | Per approved sketch — the whole point is structural impossibility. |
| Name↔URL check scope | **Vanity URLs only.** Encoded `/in/ACwAA…` URLs are skipped by this check (silently — no per-row noise) | ~79% of some datasets are encoded; a name check against them is impossible without loading profiles. Level-3 (browser spot-check) is explicitly out of scope for v1. |
| Modes covered | **All lead-reading modes**, mode-aware | URL/duplicate/template checks always; blocklist applies to cold modes (`connect_only`, `connect_and_introduce`, `connect_and_message`, `inmail_only`, `open_profile_only`). DM/ICB to existing connections skip the blocklist check. |

## Architecture

Three units, all outside the off-limits files (`src/linkedin/outreach.js`, `src/linkedin/actions.js` untouched):

### 1. `src/preflight-lint.js` (new, pure)

No I/O, no browser. Exported:

```
lintLeads({ rows, linkedinColumn, mode, templates, blocklist, sheetGid, headerRow })
  → { blockers: Finding[], warnings: Finding[], passed: Check[], targetCount }
```

`Finding = { check, severity: 'blocker'|'warning', rowIndex (1-based sheet row), leadName, detail, stampText }`

Checks (v1):

**Blockers**
- `blocklist_match` — row's Company column value OR email-column domain matches a blocklist entry (case-insensitive; company = normalized substring match on word boundaries, domain = suffix match). Cold modes only. `stampText: "Skipped: blocklist — <entry>"`.
- `name_url_mismatch` — vanity slug shares no token with First/Last name. Tokenize slug on `-`/digits, lowercase-compare against name tokens; mismatch only when BOTH first and last name tokens are absent from the slug (single-token overlap = pass; e.g. "Lavanya Vemula" vs `leonkatsnelson` → mismatch; "Mohammed Omer" vs `msajidomer` → pass, `omer` present). Encoded URLs: check not applied. `stampText: "Skipped: name≠URL"`.
- `malformed_url` — row has a non-empty LinkedIn cell that `extractLinkedInUrl` (reused from `src/campaign.js` — export it if not already) cannot parse.
- `column_invalid` — the configured `linkedinColumn` is absent from the header row, or present but the first 5 non-empty rows yield 0 valid URLs. (Sheet-level: one finding, not per-row.)
- `ambiguous_tab` — campaign sheet URL carries no explicit gid AND the spreadsheet has >1 tab. (Sheet-level.)

**Warnings**
- `duplicate_url` — ≥2 target rows normalize to the same URL (reuse the existing normalization from the v2.109 dedup). Lists the row numbers.
- `empty_template_var` — a `{variable}` used in any active template resolves to empty for N target rows (uses the same alias resolution as `personalizeTemplate` in `src/linkedin/helpers.js`; count + up to 10 row numbers).
- `list_vs_limit` — target rows > 14 × dailyLimit × account count (cosmetic sanity note, never blocks).

**Passed** — explicit confirmations: tab resolved (name + gid), LinkedIn column found, N valid target rows.

Only rows the campaign would actually process (post the existing per-mode pre-filter semantics — blank Stage for cold modes, etc.) are linted; already-terminal rows are ignored.

### 2. `src/blocklist.js` (new) + `data/blocklist.json`

```
readBlocklist() → [{ value, kind: 'company'|'domain', reason, addedBy, addedAt }]
addEntry(entry) / removeEntry(value)
```

Atomic write-tmp-then-rename like the other data files. `kind` inferred: contains a dot → domain, else company. Managed from a Blocklist panel (per `company-blocklist-A.html`) reachable from the linter overlay's "Manage blocklist" and from settings. Routes: `GET/POST/DELETE /api/blocklist`.

### 3. Wiring

- `POST /api/preflight` (server.js): body = the same campaign config the launch uses. Fetches the sheet CSV via the existing `sheets.js` path (incl. gid resolution + tab list for `ambiguous_tab`), reads the blocklist, calls `lintLeads`, returns findings. No state changes.
- **Wizard Start click** (public/js/app.js): calls `/api/preflight`, renders the overlay (markup per approved sketch, real classes). Buttons:
  - **Fix on sheet** — opens the sheet URL externally; overlay stays.
  - **Exclude flagged rows & launch** — POSTs the excluded rows' stamps to the existing Apps Script writer (`stampText` into the Stage column), then launches normally. Stamp failures are surfaced ("2 of 6 stamps failed — rows will be skipped this run but may reappear"), never silently swallowed.
  - **Launch anyway** — launches without stamping; disabled/absent when any `blocklist_match` exists (those rows are ALWAYS excluded+stamped; the button then reads "Exclude blocklisted & launch anyway").
  - **Cancel** — closes, back to wizard.
- **Server-side gate**: `launchCampaign`/queued/cloud paths re-run `lintLeads` and refuse to start when un-acknowledged blockers exist (`config.preflightAck` token returned by `/api/preflight` proves the operator saw these exact findings). Blocklist rows are excluded server-side regardless of any client behavior.
- If the preflight fetch itself fails (sheet unreachable/429), show the error and do not launch — same failure the campaign would have hit at start, surfaced earlier.

## Error handling

- Lint never throws for malformed row data — a row that breaks a check parser becomes a `malformed_url`/generic blocker for that row.
- Blocklist file missing/corrupt → treated as empty + a warning line in the overlay ("blocklist unreadable — 0 entries applied"), logged to `data/warnings.json`.
- Stamping uses the existing sheet-writer path; per-row failures reported in the launch log and the overlay result toast.

## Testing

`node --test tests/preflight-lint.test.js` + `tests/blocklist.test.js` (pure units):
- name↔URL: Lavanya/`leonkatsnelson` → blocker; Mohammed "Sajid" Omer/`msajidomer` → pass; encoded ACwAA URL → not checked; hyphenated + diacritic names.
- blocklist: company word-boundary matching ("IBM" ≠ "ibmara-consulting" company name), domain suffix ("ortusclub.com" matches `x@mail.ortusclub.com`), cold-mode-only application.
- duplicates, empty-var counting with header aliases, column_invalid, ambiguous_tab.
- blocklist.js: atomic write, corrupt-file fallback.

Manual verification: overlay against the approved sketch, a real launch on a test sheet containing one seeded bad row of each kind.

## Out of scope (v1)

- Browser spot-check of flagged profiles (Level 3) — future.
- Shared blocklist tab — future graduation path; `blocklist.js` isolates storage so only that module changes.
- Cross-campaign "already contacted by another operator" checks (that's the Connections-DB idea, separate feature).

## Version & release

Ships on a feature branch per repo convention, patch-version bump before every `npm run dev:app` relaunch. **No public release** — the company stays on the v2.120.2 installer until Antonio says otherwise.
