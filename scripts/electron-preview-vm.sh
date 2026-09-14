#!/usr/bin/env bash
set -euo pipefail
PR_NUMBER="${1:?preview PR number required}"
export ORTUS_ENGINE_NAMESPACE="salesnav-previews"
export ORTUS_ENGINE_DEPLOYMENT="preview-pr-${PR_NUMBER}-salesnav-scraper"
export ORTUS_ENGINE_PORT="${ORTUS_ENGINE_PORT:-3119}"
export ORTUS_ENGINE_ENVIRONMENT="preview"
export ORTUS_PREVIEW_PR="$PR_NUMBER"
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/electron-dev-vm.sh"
