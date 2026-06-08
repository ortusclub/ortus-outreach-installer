#!/usr/bin/env bash
#
# Push the repo's google-apps-script.js to the shared Apps Script project and
# redeploy the LIVE web app (the SHEETS_WEBAPP_URL endpoint every operator
# hits). Run apps-script-setup.sh once first.
#
# IMPORTANT: `clasp push` alone does NOT change production — the web app serves
# the last DEPLOYED version. This script pushes AND redeploys the existing
# deployment id, so the URL stays identical and the change goes live.
#
# Usage:
#   scripts/apps-script-deploy.sh <DEPLOYMENT_ID> ["description"]
#
# Find DEPLOYMENT_ID with:  (cd apps-script && clasp deployments)
# It's the long AKfycb… id of the active "Web app" deployment — the same id
# embedded in SHEETS_WEBAPP_URL in src/sheets-webapp-url.js.
set -euo pipefail

DEPLOY_ID="${1:?Pass the live Deployment ID (cd apps-script && clasp deployments)}"
DESC="${2:-repo sync $(node -p "require('./package.json').version" 2>/dev/null || echo manual)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/apps-script"
SRC="$ROOT/google-apps-script.js"

[ -f "$DIR/.clasp.json" ] || { echo "apps-script/ not set up. Run scripts/apps-script-setup.sh <SCRIPT_ID> first."; exit 1; }
[ -f "$SRC" ] || { echo "Missing $SRC"; exit 1; }

# Find the single code file pulled from the project (ignore appsscript.json /
# manifest) and overwrite it with the repo source of truth. Apps Script
# concatenates all .gs/.js files, so there must be exactly ONE code file —
# pushing a second would duplicate every function and break the script.
CODE_FILE="$(cd "$DIR" && ls -1 *.gs *.js 2>/dev/null | grep -vi 'appsscript' | head -1 || true)"
CODE_FILE="${CODE_FILE:-Code.js}"
cp "$SRC" "$DIR/$CODE_FILE"
echo "→ Synced google-apps-script.js → apps-script/$CODE_FILE"

cd "$DIR"
echo "→ Pushing code …"
clasp push --force
echo "→ Redeploying $DEPLOY_ID …"
clasp deploy -i "$DEPLOY_ID" -d "$DESC"
echo
echo "✓ Live. The SHEETS_WEBAPP_URL endpoint now runs the updated script."
echo "  (If clasp errors on deploy with a permissions message, Antonio must run"
echo "   this final deploy step, or grant deployment-management rights.)"
