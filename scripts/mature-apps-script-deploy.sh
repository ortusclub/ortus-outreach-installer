#!/usr/bin/env bash
#
# The Mature Profile sheets bridge: an independent copy of the shared sheets
# Apps Script (google-apps-script.js), hosted under info@ortus.solutions.
#
# Maturing writes go through this copy instead of the shared script — it owns
# the "Maturing Campaigns (LinkedIn)" results workbook, and it carries the
# writeMatureTab action without waiting on a redeploy of the shared script.
#
# First run creates the project and its web-app deployment; later runs push the
# current google-apps-script.js and redeploy the SAME deployment, so the URL
# never changes.
#
# One-time sign-in (opens a browser — sign in as info@ortus.solutions):
#   clasp -u ortus-info login
# Then:
#   scripts/mature-apps-script-deploy.sh ["what changed"]
#
# After the FIRST deploy, open the script once (the command is printed) and run
# `authorize` so Google asks info@ortus.solutions to grant Sheets/Drive access.
# Until that is done the web app answers with a sign-in page.
set -euo pipefail

USER_PROFILE="ortus-info"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/apps-script/maturing"          # local clasp workspace (gitignored)
SRC="$ROOT/google-apps-script.js"
DESC="${1:-repo sync $(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo manual)}"
C() { clasp -u "$USER_PROFILE" "$@"; }

[ -f "$SRC" ] || { echo "Missing $SRC"; exit 1; }
C list-scripts >/dev/null 2>&1 || { echo "Not signed in. Run:  clasp -u $USER_PROFILE login   (sign in as info@ortus.solutions)"; exit 1; }

mkdir -p "$DIR"
cd "$DIR"
if [ ! -f .clasp.json ]; then
  echo "▶ creating the Apps Script project…"
  C create-script --type standalone --title "Ortus Outreach — Maturing sheets bridge"
fi

# Exactly ONE code file: Apps Script concatenates every file in the project, so
# a second copy would duplicate every function.
find . -maxdepth 1 -type f \( -name '*.js' -o -name '*.gs' \) -delete
{
  cat "$SRC"
  cat <<'JS'

// Run once from the editor after the first deploy: it touches Sheets and Drive
// so Google shows the consent screen for the account that hosts this bridge.
function authorize() {
  SpreadsheetApp.openById('1aZFtGnJcAs4dZ4Pvw5ju5dFwkX29zP_h3s1R8K-XXfo').getName();
  DriveApp.getRootFolder().getName();
  return 'authorized as ' + Session.getEffectiveUser().getEmail();
}
JS
} > Code.js
cat > appsscript.json <<'JSON'
{
  "timeZone": "Asia/Manila",
  "dependencies": {
    "enabledAdvancedServices": [
      { "userSymbol": "Drive", "version": "v3", "serviceId": "drive" }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": { "access": "ANYONE_ANONYMOUS", "executeAs": "USER_DEPLOYING" },
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
}
JSON

echo "▶ pushing the code…"
C push --force

# The web-app deployment is the one that is not "@HEAD".
DEPLOY_ID="$(C list-deployments 2>/dev/null | grep -v '@HEAD' | grep -oE 'AKfyc[A-Za-z0-9_-]+' | head -1 || true)"
if [ -z "$DEPLOY_ID" ]; then
  echo "▶ creating the web-app deployment…"
  C create-deployment --description "$DESC"
  DEPLOY_ID="$(C list-deployments 2>/dev/null | grep -v '@HEAD' | grep -oE 'AKfyc[A-Za-z0-9_-]+' | head -1)"
else
  echo "▶ redeploying $DEPLOY_ID…"
  C update-deployment "$DEPLOY_ID" --description "$DESC"
fi
[ -n "$DEPLOY_ID" ] || { echo "Could not read the deployment id — run: (cd $DIR && clasp -u $USER_PROFILE list-deployments)"; exit 1; }

URL="https://script.google.com/macros/s/${DEPLOY_ID}/exec"
echo
echo "✅ Maturing sheets bridge is live:"
echo "   $URL"
echo "   Set it as MATURE_SHEETS_WEBAPP_URL (build/release.env for releases)."
echo "   First time only — authorise it:  (cd $DIR && clasp -u $USER_PROFILE open-script)  then run the 'authorize' function."
