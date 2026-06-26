# Ortus Outreach 2.120.0 — EOW Update

Everything new since the version on GitHub (**2.112.39**). 107 commits.

## 🆕 Sales Nav Scrape — see your place in the queue (2.120)
- New **Queue** tab in the scrape panel (Jobs · Queue · Logs) showing a position ladder: who's scraping now → how many are ahead → **you**, with an ETA. Collapses the middle for deep queues.
- Compact **Scrape strip** on the dashboard (above the campaign card), shown only when a scrape is queued/running — click to expand the same ladder.
- Queue **position + ETA** on queued jobs (Steven's scraper integration).
- Ready to show **real account names** of who's ahead the moment the engine sends them (engine spec in `docs/scraper-queue-named-ahead-engine-spec.md`).

## 🚀 Follower Growth — Team Launch (major new feature, 2.113–2.119)
- New **Follower Growth** campaign type: grow the Ortus Club LinkedIn page by inviting operators' 1st-degree connections to follow.
- **Team Launch** board: pick employees → auto-pair each to their GoLogin account → run ONE sequential batch (one browser at a time), driving a live log + summary.
- Employee roster with non-DNC connection counts; searchable GoLogin account picker; select-all; Local Browser option.
- Credit-coloured **account chooser tiles**; monthly invite cap of **30** (live modal is source of truth); per-send "why 0 sent" reasons.
- Resilient write-back, resume-running UI on reopen, ineligible-account reporting.
- Central **FG Apps Script** (Invites / Budgets / Funnel tabs) + `/api/fg` routes.

## 📇 Connection DB (2.117–2.118)
- "Connections" renamed to **Connection DB**, scrollable pick list.
- Standalone **"Create a Google Sheet"** from the DB list with an editable name, auto-shared anyone-with-link as editor, and jump-to-campaign.
- Warm-reach foundation: CSV ingestion → slug index, HubSpot CRM search, join/dedupe/DNC filter, lead-schema export.

## 🤝 Introduction Campaign — Primary Person (2.119.0–.1)
- Full CC+IC **Primary Person block** (name + URL + source) in the Introduction Campaign; `{primary url}` resolves; URL truly optional (server-gated).

## 🔧 SoO write-back reliability (2.119.23)
- Account reservation now flips **Available → In Use** via a **93% fuzzy email match** (handles typos / `.solution` vs `.solutions` / spacing), skip-on-doubt so it never reserves the wrong account.
- **Every** flip outcome is now logged — no more silent "stuck on Available".

## 🩹 Connection-note fixes (2.112.42–.43)
- Over-limit connection note detected via the char counter; pierces shadow DOM to read it correctly.

---

## ⚠️ Operator notes for this release
- **Apps Script redeploys required** for some features to work in prod: the **FG Apps Script** (Follower Growth) and **createLeadTab** (Connection DB "Create a Sheet"). Without the redeploy those features error or no-op.
- Several features are **new and not yet broadly field-tested** (FG Team Launch, ICB primary block, the SoO fuzzy fix, the scrape queue). Worth a smoke test per feature after install.
