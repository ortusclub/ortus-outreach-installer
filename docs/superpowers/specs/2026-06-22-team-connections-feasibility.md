# Team Connections Database — Feasibility Study

**Date:** 2026-06-22
**Status:** Feasibility study (pre-spec). Nothing built.
**Author:** drafted with Claude during a brainstorm session.

---

## 0. One-line verdict

**Feasible — but the join is more nuanced than the first probe suggested, and a Phase-0 spike (run 2026-06-22, see §4) now measures it directly.** HubSpot carries a LinkedIn URL on **10.75M** contacts, but **only ~21% (2.21M) are in the vanity-slug form the CSV exports use** — the other **79% are encoded** (`/in/ACwAA…`) and do *not* join by slug. Net effect: the slug join is **high-yield (~80%) for colleague networks already imported into HubSpot, but thin (~4%) for networks not yet imported** (whose contacts, where present, sit in the encoded pool). So the feature is feasible and the export→ICB tail is nearly free (it rides existing plumbing) — but **uniform, high coverage depends on us ingesting every colleague's CSV ourselves** (the side we control), with **LinkedIn member-ID resolution** as the upgrade path to also reach the encoded 79%. The earlier "de-risked, ~10.75M matchable" framing over-counted the matchable pool by ~5×.

---

## 1. What we'd build (the converged concept)

A **warm-reach lead-list builder**, living as a "Connections" section in the app:

1. **Search** HubSpot by **Geography (country / region / city) · Job titles · Companies** — all multi-value lists.
2. Each match is annotated with **"who on the team can warmly reach them"** — derived from the colleagues' LinkedIn networks (CSV exports + live-detected connections), joined to HubSpot on **LinkedIn member-ID / URL**.
3. **Do-Not-Contact / Unsubscribed are excluded** from outreach (HubSpot Lead Status / Priority = DNC).
4. The user **selects** people → **exports to a Google Sheet** (real lead schema, with a `Primary` column = the warm connector) → **runs it as an Introduce Back (ICB) campaign**.

Mockup: `public/sketches/team-connections-v2.html`.

---

## 2. Current state — what the app can do today (evidence-based)

| Capability | Status today | Evidence |
|---|---|---|
| Read/write the central **Google Sheet** | ✅ Yes, via the central Apps Script web app | `src/sheets.js`, `src/sheets-writer.js` |
| Apps Script can **create tabs + write rows** | ✅ Yes (`insertSheet`, `appendRow`, `batchUpdate`) | `google-apps-script.js` actions: `prepareSheet`, `batchUpdate`, `writeRecentConnections` (creates the `Recent Connections` tab via `insertSheet`) |
| Run a sheet as a campaign (incl. **ICB / introduce_back**) | ✅ Yes — campaigns are sheet-driven; lead detection needs **First Name + a LinkedIn-URL column** | `src/sheets.js:looksLikeLeadRows` |
| Already-captured connection signal | ✅ Partial — the shared **`Recent Connections`** tab pools all senders' recently-detected connections; `data/primary-status.json` remembers account↔primary | `google-apps-script.js` (`RECENT_TAB_NAME`), `src/primary-status-store.js` |
| **HubSpot** integration | ❌ **None** in the app today | `grep -ri hubspot src server.js` → no hits |
| **Google Drive / CSV ingestion** | ❌ **None** — the app can *emit* a CSV download, but has no Drive API, no CSV parser, no `googleapis` | only hit: `server.js:3813` (campaign-export filename) |

**Takeaway:** the *output* side (export a sheet → run ICB) is cheap — it reuses plumbing that already exists. The *input* side (HubSpot + the CSV networks) is **net-new integration work**, and is where the effort and risk sit.

---

## 3. The three data sources

### 3a. HubSpot — the searchable directory (live-queried)
- **Scale:** ~**4.7M contacts have a `country`** (verified via live count). Rich, structured.
- **Search axes all present:** `country` / `state` (region) / `city`; `jobtitle`; `company` (+ associated Company object).
- **Compliance fields present:** `Lead Status` (e.g. Unsubscribed), `Priority` = DNC (from your column screenshot) — so the DNC exclusion is data we can actually read.
- **The join key is present at scale, but mostly in the wrong form:** `linkedinbio` holds a LinkedIn URL on **10,754,601** contacts and `linkedin_membership_id` (numeric) on **~5.36M** — but **only ~2.21M (20.6%) of `linkedinbio` values are vanity slugs** (the form CSV exports use); **79.4% (8.54M) are encoded** `/in/ACwAA…` URLs (incl. Sales-Navigator `/sales/people/ACwAA…`) that need a member-ID to join a CSV. (My first pass mis-counted using `hublead_linkedin_profile_url` ≈ 2,251 — the wrong field.) Canonical vanity store form: `https://www.linkedin.com/in/<slug>` (also seen `http://`, and duplicate contacts per slug).
- **Feasibility:** HubSpot's CRM Search API supports exactly this filter shape (filterGroups: country IN [...] AND jobtitle CONTAINS-any AND company IN [...]) with pagination. Standard. Needs a **Private App token** + handling rate limits (≈ a few requests/sec, 100–200 records/page).

### 3b. LinkedIn connection CSVs — the "who can reach" layer (Drive, quarterly)
- **Location/shape:** a Drive folder per quarter (e.g. "Q2 2026"), files named **`<colleague-email>.csv`** — so **owner mapping is solved by the filename** (the Drive "Owner" column is just whoever uploaded it).
- **Access caveat (found during the spike):** the live "Q2 2026" folder (`1NnDfoeQv4-VKJqzYza4k_TFCkzNwZ7oG`, owned by pat.yanguas) is a **Shared Drive** — the Google-Drive connector can read individual files but **cannot enumerate the folder's children** by `parentId`. The spike therefore ran on the equivalent connection-export set (folder `1N7_IKZECucLZhH3zxjtGOPuRRw2zWUaO`, ~95 `<email>.csv` files, same schema). A production ingester must use a Shared-Drive-aware listing (`includeItemsFromAllDrives` / `corpora=drive`) or be handed file IDs directly.
- **Columns (standard LinkedIn export):** `First Name, Last Name, URL, Email Address, Company, Position, Connected On`.
- **Real quirks (must handle):** older exports have **no `URL` column** (names only); some rows are privacy-redacted (`,,,,,,date`); commas-in-quoted-names; unicode; occasional column misalignment. Sizes range **1 KB → 220 KB** (coverage per colleague is very uneven; some are near-empty).
- **Freshness:** re-exported **quarterly** (per-quarter folders) — staleness is bounded and already part of the team's routine.
- **Feasibility:** parsing is trivial; ingestion is the work — either **(a)** the app reads the Drive folder via Drive API, or **(b)** a simpler manual/managed import of the quarter's folder. The `<email>.csv` convention makes attribution clean.

### 3c. Live "Recent Connections" — the fresh slice (already central)
- Already accumulating in the central sheet during campaigns. Free to fold in; keeps the most recent connections current between quarterly CSV refreshes.

---

## 4. The join — measured by a Phase-0 spike (2026-06-22)

The whole value proposition is the **overlap**: *contacts that are both in HubSpot (so we know geo/title/company) AND in a colleague's network (so we can reach them warmly).* The spike measured it directly. (Dataset: the team's connection-export folder — ~95 `<email>.csv` files, standard LinkedIn schema, **100% vanity-slug URLs**; HubSpot account 2748825.)

**Finding 1 — HubSpot LinkedIn-URL forms (whole-CRM `total` counts, not a sample):**
| `linkedinbio` form | Count | Share | Joins a CSV slug? |
|---|---|---|---|
| Present (any form) | 10,754,601 | 100% | — |
| **Encoded** `/in/ACwAA…` (incl. `/sales/people/ACwAA…`) | 8,540,505 | **79.4%** | ❌ needs member-ID |
| **Vanity slug** `/in/<name>-<id>` | 2,214,096 | **20.6%** | ✅ direct, 1:1 by string |

(A default 200-row sample came back *100% encoded* — the encoded records dominate and were created in bulk imports.)

**Finding 2 — slug-exact match rate is *bimodal*, set by whether that colleague's export was already imported:**
| Network sampled | Slug-exact matches | Read of the data |
|---|---|---|
| **bea.talusan** (APAC corporate; 2,535 ext. connections) | **24 / 30 = 80%** | matches cluster at `createdate` 2024-06-25 09:41 → her export was **already bulk-imported into HubSpot in vanity form** |
| **meizi.a** (mixed Indonesia/EU L&D; ~210) | **1 / 25 = 4%** | the few that exist are stored **encoded**, not vanity |

**Finding 3 — true presence for the low-match network (name+company probe, 8 people):** ~2/8 (≈25%) are in HubSpot *at all* — but **stored encoded / Sales-Navigator**, so **zero of them slug-match**. (Emma Windsor — two encoded dupes, company stale CyberArk→Clarivate; Martim Krupenski — `/sales/people/ACwAA…,NAME_SEARCH`.)

**Finding 4 — data-quality flags:** the same slug returns **duplicate contacts** (Edmund Lee, Alex Ang, Jeffrey Chan, Emma Windsor each ×2), sometimes with different/stale company; company is unreliable on both sides.

**Interpretation:**
- The slug join **works and is high-yield (~80%) for any network already represented in HubSpot's vanity pool** — and that pool is large (2.21M) and clearly already holds bulk-imported colleague exports.
- For networks **not** previously imported, direct slug coverage is thin (~4%); their true presence (~25%) sits in the **encoded 79%**, reachable only via **member-ID resolution** (the LinkedIn Voyager endpoint) or fuzzy name/company.
- So overall coverage is an **"already-ingested vs not"** story, not a single rate. **The lever we control:** ingest every colleague's CSV into our own index in vanity form — then the index *is* the warm layer regardless of HubSpot's URL form, and HubSpot is queried only for geo/title/company + DNC on the people we surface.

**Finding 5 — member-ID is the volume key, and the HubSpot side is ready for it:**
- `linkedin_membership_id` (numeric) present on **5,359,430** contacts; **4,945,192 of the encoded 79% also carry the numeric ID** (only 4,370 have an ID but no URL). Each encoded `/in/ACwAA…` record sits next to its numeric ID (e.g. `Zachary Schneeweis → 380323286 ↔ /in/ACwAABarRdYB…`).
- Slug and member-ID are **complementary** (overlap ~0.4M): slug→2.21M (21%), member-ID→5.36M (50%), **both together ≈ 7.2M (~66% of all 10.75M URL-bearing) — ~3.2× the slug-only reach**, and far more uniform across colleagues.
- **The catch is CSV-side:** the export carries only the vanity slug, never the member-ID. So member-ID matching needs a **slug→ID resolve step via the LinkedIn Voyager endpoint** (the app's existing capability — resolve numeric memberId from a slug; already exercised by CC+IC). That's a per-profile LinkedIn call: rate-limited, account-safety/ToS-sensitive, cached, quarterly. *Validate once that Voyager's numeric == HubSpot `linkedin_membership_id` on 2–3 known profiles.*

**Revised join strategy (precision-ordered — slug + member-ID are complementary, use both):**
1. **Vanity-slug URL** (normalize both sides to `/in/<slug>`) — the **free workhorse**: matches the 2.21M vanity pool 1:1, ~80% on already-imported networks, zero LinkedIn calls. Our ingested index is vanity-keyed by construction.
2. **LinkedIn member-ID** — the **volume multiplier (Phase-1.5)**: resolve CSV slug→ID (Voyager), match against HubSpot's 5.36M `linkedin_membership_id` to reach the encoded 79%. Lifts matchable pool to ~7.2M.
3. **Email** — where the CSV row has one (sparse).
4. **Name + company** — *suggestions only, never auto-actioned* (the CC+IC "Already connected" false-positive class).
- Plus: **dedupe HubSpot contacts** (same slug/ID → multiple records) and treat company as possibly stale.

---

## 5. Architecture — options & recommendation

**Where does the unified graph live?** The pooled network is large: hundreds of colleagues × up to ~tens of thousands of connections each = **potentially millions of rows**. That rules out a Google Sheet as the store (you've already hit the ~10M-cell ceiling once; this would blow past it). Options:

| Option | Fit | Notes |
|---|---|---|
| **A. Sheet as store** | ❌ | Too big; cell-limit risk; slow to query. Only fine for the *exported lead list* (small), not the graph. |
| **B. Local index in the app (recommended)** | ✅ | Ingest CSVs → a compact index keyed by member-ID/URL (e.g. SQLite or an on-disk map) per operator or shared. Query-time: HubSpot live + index lookup. Scales, fast, no new central infra. |
| **C. HubSpot as the only store** | ⚠ | Write "reachable-by" back onto contacts. Cleanest conceptually but means bulk-writing to HubSpot + the join still has to happen somewhere. |

**Recommended data flow (Option B):**
1. **Ingest** (quarterly): read the `<email>.csv` files → normalize → build a `connections index` keyed by LinkedIn member-ID/URL → value = list of colleagues connected + connected-on date. Fold in the live `Recent Connections`.
2. **Search** (live): query HubSpot by geo/title/company (+ exclude DNC).
3. **Annotate:** for each HubSpot result, look up the index by member-ID/URL → attach the warm connector(s).
4. **Select → Export:** write chosen rows to a **new tab** in the central workbook (via a new Apps Script action, e.g. `createLeadList`) with the real lead schema + a `Primary` column.
5. **Launch** that tab as an ICB campaign (existing machinery).

HubSpot = system of record for contacts; the local index = the warmth layer; the sheet = only the small, exported lead list.

---

## 6. Build phases & rough effort

| Phase | Scope | Rough effort | Gate |
|---|---|---|---|
| **0 · Join-coverage spike** | ✅ **DONE 2026-06-22** (§4): 79% of HubSpot LinkedIn URLs encoded / 21% vanity; slug match 4%→80% depending on prior import. Conclusion: viable, but coverage comes from **ingesting our own CSV index**, not from HubSpot's URL form. | — | **Gate passed** |
| **1 · Data plumbing** | HubSpot Private-App auth + CRM search; CSV ingestion + the connections index; DNC read | ~3–5 days | |
| **2 · Search & annotate UI** | The Connections section: multi-value geo/title/company search → warm-annotated results (the v2 sketch) | ~2–4 days | |
| **3 · Export → ICB** | Selection → `createLeadList` Apps Script action → new tab in real schema + `Primary` → launch as ICB; per-Primary grouping | ~2–3 days | |
| **4 · Refresh & health** | Quarterly re-ingest, a small "data health" view (which colleagues loaded / stale / no-URL) | ~1–2 days | |

(Estimates are order-of-magnitude for one developer; Phase 0 must come first.)

---

## 7. Risks & unknowns (ranked)

1. **Encoded-majority HubSpot URLs (MED — measured)** — 79% of `linkedinbio` is encoded `/in/ACwAA…`, so CSV slugs only join the 21% vanity pool directly; the encoded pool needs member-ID resolution. *Mitigation: build coverage from our **own vanity-keyed ingested index** (the side we control); add Voyager member-ID resolution later to widen reach into the encoded pool.*
2. **Coverage is bimodal, not uniform (MED — measured)** — slug match ran 4%→80% across two real networks, depending on whether that colleague's export was already imported. *Mitigation: ingest **all** colleagues' CSVs so the index is complete regardless of HubSpot's prior imports.*
3. **HubSpot duplicates + stale company (MED — observed)** — same slug → multiple contacts; company drifts (e.g. CyberArk→Clarivate). *Mitigation: dedupe by member-ID/slug at ingest; prefer most-recently-modified; don't trust company as a join key.*
4. **Name-match temptation (HIGH if ignored)** — fuzzy matching to widen coverage = the known false-positive class. *Mitigation: ID-only joins auto-action; names are suggestions only.*
5. **HubSpot API auth across operators (MED)** — token management for a desktop app shipped to ~3+ operators; rate limits shared. *Mitigation: one private-app token via the central backend; cache search results.*
6. **CSV ingestion path (MED)** — Drive API access (incl. **Shared-Drive listing**, see §3b caveat) + the quirks (no-URL exports, redacted rows, sizes 1 KB–220 KB). *Mitigation: Shared-Drive-aware, tolerant parser; the `<email>.csv` naming makes attribution clean.*
7. **Graph scale (MED)** — millions of edges; not a sheet. *Mitigation: local index store (Option B).*
8. **Staleness (LOW)** — CSVs are quarterly snapshots. *Mitigation: live Recent Connections fills the gap; show export date.*
9. **ToS / privacy (LOW)** — uses *official* LinkedIn data exports (no scraping) ✅; but it pools colleagues' full networks + HubSpot PII for internal use — worth a governance nod.

---

## 8. Open decisions (for the spec)

1. **Per-Primary grouping** — one ICB campaign grouped by the warm connector, or split into a tab/campaign per colleague? (Different people are reachable by different colleagues.)
2. **Where it lives** — local index in the app (recommended) vs HubSpot-as-store.
3. **Auth model** — *decided 2026-06-22:* **MVP = local `.env` token** (single operator, not shipped → no leak surface; `.env` is gitignored + untracked, verified). **Ship = Cloudflare Worker proxy** holding the token as a Worker secret (like the HS extension / `ortus-links`), so no operator machine bundles the secret and it's centrally revocable. `src/connections/hubspot-client.js` is isolated so the swap (HubSpot base URL → Worker URL, drop token) is a one-file change. *(Service Key chosen over a legacy Private/Public app — single-account, future-supported.)*
4. **Ingestion** — app reads Drive directly vs a managed quarterly import.
5. **ICB mechanic** — confirm: the warm connector is the *primary* the lead is introduced to/by (resolves the earlier ambiguity).

---

## 9. Recommendation

**Phase 0 is done and the feature clears the gate — with a sharpened design.** The spike showed the join can't lean on HubSpot's LinkedIn URLs (79% are encoded), so **coverage must come from our own ingested, vanity-keyed connection index** — the side we fully control. Concretely:

1. **Proceed to Phase 1**, but make the **CSV ingestion + local index the backbone** (not an afterthought): ingest *every* colleague's `<email>.csv` so the warm layer is complete regardless of what HubSpot already holds. HubSpot becomes the *attribute + DNC* lookup on the people we surface, not the join authority.
2. **Dedupe + freshness:** collapse duplicate HubSpot contacts by member-ID/slug; treat company as possibly stale (verify at export, not at match).
3. **Defer member-ID (Voyager) resolution to a Phase-1.5 upgrade** — it widens reach into the encoded 79% but isn't needed to ship value on the vanity pool first.
4. The **export→ICB tail stays nearly free** (rides existing Apps Script + campaign plumbing).

The earlier worry ("overlap might sink it") is resolved: overlap is real and high where we ingest. The remaining engineering is well-understood.

---

## Appendix A — Phase-0 spike: method & raw results (2026-06-22)

**Tools:** Google-Drive connector (read CSVs) + HubSpot CRM search (`search_crm_objects`), account 2748825.

**HubSpot URL-form counts** (each a `total` from a filtered search, whole-CRM, not a sample):
- `linkedinbio HAS_PROPERTY` → **10,754,601**
- `linkedinbio CONTAINS_TOKEN 'ACwAA*'` (encoded) → **8,540,505** (79.4%)
- `HAS_PROPERTY AND NOT_CONTAINS_TOKEN 'ACwAA*'` (vanity) → **2,214,096** (20.6%)
- 200-row default sample of `linkedinbio` values: 200/200 encoded, all `https://www.` prefix, no trailing slash.

**Member-ID counts** (the volume-key analysis):
- `linkedin_membership_id HAS_PROPERTY` → **5,359,430**
- `CONTAINS_TOKEN 'ACwAA*' AND linkedin_membership_id HAS_PROPERTY` → **4,945,192** (encoded records that also carry the numeric ID)
- `linkedin_membership_id HAS_PROPERTY AND linkedinbio NOT_HAS_PROPERTY` → **4,370** (ID but no URL)
- Sample: numeric IDs pair with the encoded URL on the same record (Zachary Schneeweis `380323286` ↔ `/in/ACwAABarRdYB…`; Sean Jones `191550833`; Yelena Kozorezova `1023366366`).
- Implied union (slug ∪ member-ID, overlap ~0.4M): **≈ 7.2M matchable (~66%)** vs 2.21M (21%) slug-only.

**Slug-exact match test** (CSV vanity URL normalized to `https://www.linkedin.com/in/<slug>`, matched via `linkedinbio IN [...]`):
- **bea.talusan** (`17Yg_4YRQLZ_CT9oiu5GAtzTS5ZluwZWd`; 2,849 rows, 2,666 with `/in/` URL, 2,535 external, CSV 100% vanity): **24/30 distinct slugs matched (~80%)**; 27 records incl. 3 duplicate pairs; many matches share `createdate` 2024-06-25 09:41 (prior bulk import).
- **meizi.a** (`1A2Jb0bRJhkYaK8wIWBJLmj_0SB8MIQO3`, ~210 connections): **1/25 (~4%)** — only Elina Diamantaki (Kaizen Gaming).

**True-presence probe** (name+company free-text, 8 of meizi's non-matches): **2/8 present, both encoded** — Emma Windsor (2 encoded dupes, company stale CyberArk→Clarivate), Martim Krupenski (`/sales/people/ACwAA…`). The other 6 returned 0 results.

**Access note:** the live "Q2 2026" Shared-Drive folder (`1NnDfoeQv4-VKJqzYza4k_TFCkzNwZ7oG`) would not enumerate via the connector; spike ran on the equivalent export folder `1N7_IKZECucLZhH3zxjtGOPuRRw2zWUaO` (~95 `<email>.csv`, same schema).

**Caveats:** two networks sampled (n=55 slug tests) → directional, not precise; `IN`-total can over-count when a slug has duplicate contacts; name-presence probe carries the usual false-pos/neg risk and is a rough proxy. A full run would compute per-colleague match rates across all ~95 files (cheap to automate) — but the structural conclusions (encoded-majority; ingest-driven coverage) are robust.
