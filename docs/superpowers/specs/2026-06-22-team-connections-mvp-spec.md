# Team Connections — Lean MVP Spec ("does it work for me")

**Date:** 2026-06-22
**Status:** Spec (pre-plan). Builds on the feasibility study `2026-06-22-team-connections-feasibility.md` (read §4 + Appendix A for the join evidence).
**Goal of this MVP:** prove, on Antonio's own target searches, that joining the team's LinkedIn networks to HubSpot surfaces *real, warm, DNC-safe* leads and drops out a ready-to-run ICB sheet — **before** investing in the polished multi-operator feature.

---

## 1. One-sentence scope

A single-operator pipeline: **search HubSpot (geo / title / company) → annotate each match with the colleague(s) who can warmly reach them (slug match against locally-ingested connection CSVs) → drop DNC → write a lead-schema sheet with a `Primary` = connector column.**

---

## 2. In scope vs out (pin this — do not drift)

**Done looks like (acceptance criteria):**
1. Point the tool at a **local folder** of `<email>.csv` LinkedIn exports → it ingests them into an in-memory slug→colleague index and prints stats (files, rows, valid-URL rows, unique slugs, per-colleague counts).
2. Run a search with **multi-value** countries / regions / cities / job-titles / companies → it queries HubSpot, **excludes** `Lead Status = Unsubscribed` and `Priority = DNC`, **dedupes** contacts, and returns each result annotated with `warmVia: [colleague…]`.
3. Results with **no** warm connector are still returned but clearly flagged (so coverage is visible, not hidden).
4. Select/keep the warm rows → produce a **CSV in the real lead schema** (cols in §6) with `Primary` populated from the connector. Antonio can paste that into a sheet tab and launch it as ICB.
5. Antonio runs it on ≥1 real target search (e.g. Singapore tech leaders) and confirms the warm matches are genuine.

**Explicitly NOT in this MVP (deliberate cuts):**
- ❌ Member-ID / Voyager slug→ID resolution (that's Phase-1.5 — the ~3× volume upgrade).
- ❌ Live Google Drive API / Shared-Drive ingestion (use a local folder).
- ❌ Multi-operator / central token / auth UI (one local `.env` token).
- ❌ Writing directly into the central workbook via a new Apps Script action (MVP emits a CSV; folding into a tab is a fast-follow).
- ❌ Polished Connections UI, data-health dashboard, saved-list management.
- ❌ Any write back to HubSpot (read-only).

---

## 3. Worked example (the value, in one screen)

Search: country `Singapore`; titles `Director, Head of, VP, CTO`. Pipeline returns (these are **real** spike matches — HubSpot contacts whose vanity URL is in **Bea Talusan**'s network):

| Name | Company | warmVia | DNC |
|---|---|---|---|
| Siddharth Sharma | StarHub | Bea Talusan | clear |
| Yash Deshpande | Microsoft | Bea Talusan | clear |
| Tawatchai Tongchung | Bridge Data Centres | Bea Talusan | clear |
| Elson Chia | NTT Singapore | Bea Talusan | clear |

Export → lead-schema CSV → launch as Introduce Back, with Bea as the `Primary`. **What Antonio gets:** warm intro paths nobody could surface by hand (24/30 of Bea's sampled connections were already in HubSpot), warm-first instead of cold, DNC-safe, zero reformatting.

---

## 4. Architecture (small, isolated units)

New code lives under `src/connections/` (net-new; touches nothing in `src/linkedin/*`). Each unit has one job and a clean interface.

```
local CSV folder ─► csv-ingest ─► index (Map: slug → [{colleague, connectedOn}])
                                        │
search params ──► hubspot-client ─► contacts[] ─► match (join + dedupe + DNC) ─► annotated[]
                                                                                    │
                                                                       export ─► lead-schema CSV
```

### 4.1 `src/connections/slug.js` — shared normalization
- `normalizeSlug(url) -> string | null`
- Lowercase; strip scheme/host; take the `/in/<slug>` segment; drop query string and trailing slash; decode `%`-escapes; return `null` if no `/in/` segment (e.g. `/sales/people/…`, blank, redacted).
- Used by **both** sides so the keys are identical.

### 4.2 `src/connections/csv-ingest.js` — networks → index
- `ingestFolder(dirPath) -> { index: Map<string, Array<{colleague, connectedOn}>>, stats }`
- `colleague` = filename minus `.csv` (the `<email>` convention; the spike confirmed this is the owner).
- Tolerant parse (real quirks from the spike): skip the leading `Notes:` preamble; detect the `First Name,Last Name,URL,…` header; handle quoted fields with embedded commas; unicode; **skip** rows with no `/in/` URL (older exports / redacted rows) and count them.
- `stats`: `{ files, rows, withUrl, skippedNoUrl, uniqueSlugs, perColleague: {email: count} }`.

### 4.3 `src/connections/hubspot-client.js` — CRM search
- `searchContacts({ countries?, regions?, cities?, jobTitles?, companies?, limit? }) -> Array<Contact>`
- Reads `process.env.HUBSPOT_TOKEN`. Builds CRM Search `filterGroups`:
  - `country IN [...]` (+ optional `state IN`, `city IN`) — AND.
  - `jobtitle` → one `CONTAINS_TOKEN` filter per title, combined as **OR** (separate filterGroups, since OR across groups).
  - `company IN [...]` when provided.
- Properties pulled: `firstname,lastname,linkedinbio,linkedin_membership_id,country,state,city,jobtitle,company,hs_lead_status,<DNC prop>`.
- Pagination via `offset`; on HTTP 429 back off and retry (cap retries); page size 100–200.
- Returns plain `Contact` objects (no HubSpot SDK shape leaking out).

### 4.4 `src/connections/match.js` — join + dedupe + DNC
- `annotate(contacts, index) -> Array<{contact, warmVia: string[], hasWarm: boolean}>`
- For each contact: `normalizeSlug(contact.linkedinbio)` → look up `index` → `warmVia`.
- **Dedupe** contacts that share a normalized slug (or `linkedin_membership_id`) into one row (prefer most-recently-modified; merge `warmVia`).
- **DNC filter:** drop where `hs_lead_status == 'Unsubscribed'` or the DNC/`Priority` property is set. (Confirm exact internal prop name during build via `search_properties`.)

### 4.5 `src/connections/export.js` — lead-schema CSV
- `writeLeadCsv(rows, outPath) -> path`
- Maps annotated rows → the lead schema (§6); `Primary` = first/chosen `warmVia`, resolved to a display name + profile URL via `colleagues.json` (§5). Writes UTF-8 CSV.

### 4.6 Entry point (lean): CLI command `scripts/warm-reach.js`
- `node scripts/warm-reach.js --csv-dir ./data/connections --country Singapore --title "Director" --title "Head of" --out ./out/warm-reach.csv`
- Orchestrates ingest → search → annotate → export; prints the stats + a results preview table to stdout.
- *(Why CLI not UI for the MVP: it's the fastest way to validate the data on Antonio's real searches. Wiring the v2 sketch to a `/api/connections/*` route is the immediate fast-follow once the pipeline is proven.)*

---

## 5. Config & inputs (what Antonio provides)

- **`.env`:** `HUBSPOT_TOKEN=<private app token>` — **Antonio creates this** in HubSpot → Settings → Integrations → Private Apps (scopes: `crm.objects.contacts.read`). Claude cannot create or type it. **This is the one hard dependency to run.**
- **CSV folder:** Antonio downloads the team's Q2 2026 `<email>.csv` files into `./data/connections/` (gitignored — never commit; networks are PII).
- **`src/connections/colleagues.json`:** small map `{"<email>": {"name": "...", "linkedinUrl": "..."}}` so `Primary` resolves to a name + profile URL for the ICB intro template. Seed with the handful of colleagues whose CSVs we ingest; unknown emails fall back to the email string.

---

## 6. Lead-schema CSV columns (export)

`First Name | Last Name | LinkedIn URL | Company | Job Title | Country | Primary | Primary URL | Stage`

- `LinkedIn URL` = the contact's vanity URL (satisfies `looksLikeLeadRows`: First Name + URL present).
- `Primary` / `Primary URL` = the warm connector's name + profile (feeds the ICB intro `{primary name}` / `{primary url}` template).
- `Stage` left blank (the campaign sets it).

---

## 7. Error handling

- Missing `HUBSPOT_TOKEN` → fail fast with a one-line instruction.
- HubSpot 429 / 5xx → exponential backoff, capped retries, then surface a clear error (don't silently truncate results).
- Empty/at-path-missing CSV folder → warn and exit (don't produce an empty sheet silently).
- Malformed CSV rows → skip + increment `skippedNoUrl`/`malformed` counters (reported, never crash the run).
- Zero results / zero warm matches → say so explicitly (this is a *finding* for the "does it work for me" test, not a failure).

---

## 8. Testing (`node --test`, pure-helper first)

- `slug.test.js` — normalization: vanity, trailing slash, `%`-encoding, `www`/`http(s)` variants, `/sales/people/…` → null, blank → null.
- `csv-ingest.test.js` — fixture CSV with: Notes preamble, quoted-comma name, unicode, a no-URL row, a redacted `,,,,,,date` row → correct index + stats.
- `match.test.js` — join hit/miss; dedupe two records same slug; DNC drop; merge `warmVia` across colleagues.
- `hubspot-client.test.js` — filterGroups builder shape (countries/titles/companies → correct AND/OR structure) tested against a **recorded** response fixture; **no live API calls in tests**.
- Manual: one real run by Antonio on a live search (the actual acceptance gate).

---

## 9. Constraints (carry over from the repo)

- Node ≥22, Express 4, vanilla JS, no bundler. `node --test`.
- **Never** touch `src/linkedin/outreach.js` / `actions.js`.
- **Never** `git add -A`/`.`; **never** commit `data/` (the CSV folder + any networks). Add `data/connections/` to `.gitignore`.
- If/when runtime code changes land and we relaunch `dev:app`, bump `package.json` patch version first.
- Read-only to HubSpot; no external sends; output is a local CSV the operator reviews before launching.

---

## 10. Open before build (1 item)

- **HubSpot token** — does Antonio already have a Private App token, or create one now? (Doesn't block writing the *plan*; blocks the live test run.)

Everything else is decided above (lean CLI, local folder, CSV output, slug-only, single operator).

---

## 11. Next step

Run **writing-plans** against this spec → commit-sized, test-first tasks (slug → ingest → hubspot-client → match → export → CLI wiring), then **subagent-driven-development** to build it. The export→ICB tail and member-ID (Phase-1.5) come after this proves out.
