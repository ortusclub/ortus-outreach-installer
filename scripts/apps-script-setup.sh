#!/usr/bin/env bash
#
# ONE-TIME setup so this repo can push + deploy the shared "ORTUS LINKEDIN
# TRACKER" Apps Script (the SHEETS_WEBAPP_URL endpoint) via clasp.
#
# PREREQUISITE — Antonio must first:
#   1. Share the central Apps Script project's container sheet
#      (https://docs.google.com/spreadsheets/d/1YL-sa8OnMs-VwNKcIe75TrUdzFTvYKeezxX-RUuAeBM)
#      with sam@ortusclub.com as **Editor**, AND
#   2. Send you the **Script ID** (Apps Script editor → Project Settings → IDs).
#
# Usage:
#   scripts/apps-script-setup.sh <SCRIPT_ID>
#
# Result: an apps-script/ clasp workspace (gitignored) wired to the real
# project, with the live code pulled down. After this, use
# scripts/apps-script-deploy.sh to ship changes.
set -euo pipefail

SCRIPT_ID="${1:?Pass the Apps Script Script ID (Project Settings → IDs)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/apps-script"

command -v clasp >/dev/null || { echo "clasp not installed (brew install clasp)"; exit 1; }
clasp show-authorized-user >/dev/null 2>&1 || { echo "Not logged in. Run: clasp login"; exit 1; }

mkdir -p "$DIR"
cat > "$DIR/.clasp.json" <<EOF
{
  "scriptId": "$SCRIPT_ID",
  "rootDir": "."
}
EOF

echo "→ Pulling the live project into apps-script/ …"
( cd "$DIR" && clasp pull --force )

echo
echo "✓ Setup complete. Project files pulled to apps-script/:"
ls -1 "$DIR" | sed 's/^/    /'
echo
echo "Next: edit google-apps-script.js (the repo source of truth), then run:"
echo "    scripts/apps-script-deploy.sh <DEPLOYMENT_ID>"
echo "Find the live DEPLOYMENT_ID with:  (cd apps-script && clasp deployments)"
