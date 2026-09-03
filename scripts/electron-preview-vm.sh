#!/usr/bin/env bash
# Open this desktop branch against one temporary PR preview engine.
set -euo pipefail

PR_NUMBER="${1:-}"
[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || {
  echo "Usage: npm run electron:preview -- PR_NUMBER" >&2
  exit 1
}

# A stable per-PR port permits several previews at once without replacing the
# shared DEV-38 tunnel on 3001. Override only when that port is already used.
PORT="${ORTUS_ENGINE_PORT:-$((3100 + PR_NUMBER % 500))}"

export ORTUS_ENGINE_NAMESPACE="salesnav-previews"
export ORTUS_ENGINE_DEPLOYMENT="preview-pr-${PR_NUMBER}-salesnav-scraper"
export ORTUS_ENGINE_PORT="$PORT"
export ORTUS_ENGINE_ENVIRONMENT="preview"
export ORTUS_PREVIEW_PR="$PR_NUMBER"

exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/electron-dev-vm.sh"
