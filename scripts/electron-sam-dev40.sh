#!/usr/bin/env bash
set -euo pipefail

# Sam's frozen source release. This launcher fails before Electron starts if
# Kubernetes runs any image other than the exact DEV-40 build.
export GOLOGIN_REQUEST_PACING=1
export ORTUS_PREVIEW_ISOLATED_DATA=1
export ORTUS_ENGINE_PORT=3140
export ORTUS_EXPECTED_ENGINE_TAG=preview-pr-40-cbeb766
export ORTUS_ENGINE_LABEL=DEV-40
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/electron-preview-vm.sh" 40
