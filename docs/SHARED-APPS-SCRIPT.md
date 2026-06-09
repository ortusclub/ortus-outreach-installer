# Editing the shared sheets Apps Script from this repo

The bot writes to Google Sheets through ONE deployed Apps Script — the
"ORTUS LINKEDIN TRACKER" web app at `SHEETS_WEBAPP_URL`
(`src/sheets-webapp-url.js`). Its source of truth is **`google-apps-script.js`**
at the repo root. It's bound to the central sheet
`1YL-sa8OnMs-VwNKcIe75TrUdzFTvYKeezxX-RUuAeBM` and **owned/deployed by Antonio**
(runs "Execute as: Antonio"). Every operator hits this same URL.

Goal: edit `google-apps-script.js` here, then `push + redeploy` via clasp —
no copy-paste into the Apps Script editor, and the URL never changes.

## One-time: what to ask Antonio

> Can you give sam@ortusclub.com access to the central LinkedIn-tracker Apps
> Script so I can push updates via clasp? Two things:
> 1. Share the container sheet
>    `https://docs.google.com/spreadsheets/d/1YL-sa8OnMs-VwNKcIe75TrUdzFTvYKeezxX-RUuAeBM`
>    with **sam@ortusclub.com as Editor**.
> 2. Send me the **Script ID** (Apps Script editor → ⚙ Project Settings → IDs).
>
> If `clasp deploy` later fails on permissions, I'll send you the one redeploy
> command to run, or you can grant deployment-management rights.

## One-time setup (after access granted)

```bash
scripts/apps-script-setup.sh <SCRIPT_ID>      # writes apps-script/.clasp.json, pulls live code
(cd apps-script && clasp deployments)         # note the live "Web app" DEPLOYMENT_ID (AKfycb…)
```

The `apps-script/` folder is a local clasp workspace (gitignored). The committed
source of truth stays `google-apps-script.js`.

## Every change after that

```bash
# 1. edit google-apps-script.js (+ tests), commit
# 2. ship it live:
scripts/apps-script-deploy.sh <DEPLOYMENT_ID> "what changed"
```

`apps-script-deploy.sh` copies `google-apps-script.js` over the project's single
code file, `clasp push`es, then `clasp deploy -i <DEPLOYMENT_ID>` so the SAME URL
serves the new version. (Plain `clasp push` does NOT change production — the web
app serves the last *deployed* version.)

## Notes / gotchas

- **Exactly one code file** must live in `apps-script/` besides `appsscript.json`
  — Apps Script concatenates all `.gs`/`.js` files, so a stray second file
  duplicates every function and breaks the script. The deploy script overwrites
  the existing pulled file rather than adding a new one.
- The DEPLOYMENT_ID is the `AKfycb…` segment embedded in `SHEETS_WEBAPP_URL`.
- Pending change awaiting first deploy: **`needsLogin → 'Needs Login'`** column
  write (v2.84.0). Until this script is redeployed, the bot's writes no-op.
- Same pattern would work for the other two shared scripts
  (`OPS_LOG_WEBAPP_URL`, `CAMPAIGN_LOG_WEBAPP_URL`) if ever needed — they're
  separate Apps Script projects with their own Script/Deployment IDs.
