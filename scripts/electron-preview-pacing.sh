#!/usr/bin/env bash
set -euo pipefail
export GOLOGIN_REQUEST_PACING=1
export ORTUS_ENGINE_PORT=3119
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/electron-preview-vm.sh" 19
