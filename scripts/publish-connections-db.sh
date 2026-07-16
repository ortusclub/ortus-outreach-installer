#!/usr/bin/env bash
# scripts/publish-connections-db.sh — push the local connections DB to GCS, then
# tell the running service to reload. Run after each re-ingest (Connections → Sync).
set -euo pipefail
BUCKET="${FG_ROSTER_BUCKET:-ortus-fg-connections-db}"
URL="${FG_ROSTER_URL:-https://scraper.ortusclub.com/fg-roster}"
TOKEN="${FG_ROSTER_TOKEN:-ortus2026scraper}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# NOTE: gsutil `-m` (parallel) AND `rsync` both HANG on this machine's Python 3.14
# (workers spawn, 0 bytes transferred). Plain serial `cp` is the only reliable path.
# Trade-off vs the old `rsync -d`: cp adds/overwrites but does NOT prune CSVs for
# colleagues removed from the local folder — clear those by hand if it ever matters.
gsutil cp "$ROOT/data/connections/"*.csv "gs://$BUCKET/connections/"
gsutil cp "$ROOT/data/connections-cache.json" "gs://$BUCKET/connections-cache.json"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$URL/admin/refresh" && echo " refreshed"
