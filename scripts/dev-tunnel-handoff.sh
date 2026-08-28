#!/usr/bin/env bash
# Print a single line another developer can paste into their terminal to get on
# the development engine.
#
# Why a paste line and not "here's a file": the tunnel credential has to reach
# them somehow, and one command that installs AND verifies leaves less room for
# a half-finished setup than "save this attachment to exactly this path".
#
# THE LINE CONTAINS A CREDENTIAL. Send it through 1Password, Keeper, or any
# private channel — never a shared Slack channel, never email, never a ticket.
# It is read-only (it can list the dev namespace and open a port-forward, and it
# is refused if it tries to change anything) and revoked in one command:
#
#   kubectl -n salesnav-dev delete sa ortus-dev-tunnel
#
# Note that revoking cuts off EVERY developer using this token. If you want them
# individually revocable, apply k8s-dev/30-tunnel-serviceaccount.yaml again under
# a second ServiceAccount name and generate a separate credential per person.
set -euo pipefail

SRC="${ORTUS_DEV_KUBECONFIG:-$HOME/.kube/ortus-dev.yaml}"
if [ ! -f "$SRC" ]; then
  echo "No tunnel credential at $SRC — run scripts/dev-tunnel-kubeconfig.sh first."
  exit 1
fi

# base64 so the paste survives any chat client that would otherwise reflow the
# YAML, smarten the quotes, or eat the indentation.
BLOB="$(openssl base64 -A < "$SRC")"

cat <<EOF

Send the block below privately (1Password, not Slack). One line, they paste it
into Terminal. It installs the credential and immediately proves it works — if
they see the salesnav-scraper deployment listed, they are connected.

────────────────────────────────────────────────────────────────────────────
mkdir -p ~/.kube && printf %s '$BLOB' | openssl base64 -A -d > ~/.kube/ortus-dev.yaml && chmod 600 ~/.kube/ortus-dev.yaml && KUBECONFIG=~/.kube/ortus-dev.yaml kubectl -n salesnav-dev get deploy salesnav-scraper
────────────────────────────────────────────────────────────────────────────

Then, from their clone of the app repo, they launch with:

────────────────────────────────────────────────────────────────────────────
cd <their app repo> && KUBECONFIG=~/.kube/ortus-dev.yaml scripts/electron-dev-vm.sh
────────────────────────────────────────────────────────────────────────────

The boot banner should read "dev engine: dev-14". If it says v139 they are
still on production — the launcher script is the only thing that moves the app
off it, so check they did not start the app with npm run dev:app.

They need kubectl installed (brew install kubectl). They do NOT need gcloud,
a Google account, or any access to the project.

EOF
