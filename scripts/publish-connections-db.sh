#!/usr/bin/env bash
# scripts/publish-connections-db.sh — push the local connections DB to GCS, then
# tell the running service to reload. Run after each re-ingest (Connections → Sync).
set -euo pipefail
BUCKET="${FG_ROSTER_BUCKET:-ortus-fg-connections-db}"
URL="${FG_ROSTER_URL:-https://scraper.ortusclub.com/fg-roster}"
TOKEN="${FG_ROSTER_TOKEN:-ortus2026scraper}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

gsutil -m rsync -r -d "$ROOT/data/connections" "gs://$BUCKET/connections"
gsutil cp "$ROOT/data/connections-cache.json" "gs://$BUCKET/connections-cache.json"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$URL/admin/refresh" && echo " refreshed"
