# Google Apps Script deployment note (Phase 11.3)

Changes to `google-apps-script.js` in this repo do NOT auto-deploy.

**After Phase 11.3 lands, do this once:**

1. Open the master Google Sheet (the one whose script editor owns the webapp)
2. `Extensions → Apps Script`
3. Open `Code.gs` (or whatever the main file is in the editor)
4. Copy the contents of `/google-apps-script.js` from this repo → paste over the file in the Apps Script editor
5. Save (Cmd+S)
6. Verify: if the deployment was already live, save alone is enough. If this is a first deploy, run `Deploy → New Deployment → Web app` and copy the URL into `.env` as `SHEETS_WEBAPP_URL`.

**What changed in this phase:**

- `TRACKING_COLUMNS` gained `Reply`, `Reply At`, `Reply Preview` — these columns will be auto-added to any sheet that runs a Check DMs scan for the first time.
- `FIELD_MAP` gained `Reply`, `ReplyAt`, `ReplyPreview` (payload keys from `src/sheets-writer.js` → column names).
- New `handleGetRowStatus(sheet, data)` action handler — returns the row matching a given LinkedIn URL so the check-dms orchestrator can implement non-destructive writeback.
- New `getRowStatus` case in the `doPost` router.

**Why we need this:** `check-dms.js` wants to know if a row already has `Reply="yes"` (operator manually marked or prior scan) before writing. Without this endpoint, every Check DMs run would stomp over operator edits.

**If you forget to re-paste:** the scan still works, but every check will call `getRowStatus`, get an error, and skip the non-destructive guard. It will then call `updateRow` which writes `Reply="yes"` unconditionally — operator manual edits to Reply columns would be lost on the next check.

**Verification after paste:** run a Check DMs scan with one lead that already has `Reply="yes"` manually set. Confirm the row is NOT overwritten and the scan logs skip reason `already-replied`.
