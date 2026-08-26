#!/usr/bin/env bash
# Launch this worktree against the isolated GKE development engine.
#
# Unlike a one-shot `kubectl port-forward`, this supervisor reconnects when GKE
# replaces or preempts the API pod. It also reads both deployed image tags before
# launch, so the in-app safety banner reports what Kubernetes actually runs.
set -u

DEV_NAMESPACE="salesnav-dev"
LIVE_NAMESPACE="salesnav-scraper"
DEPLOYMENT="salesnav-scraper"
LOCAL_ENGINE_PORT="3001"
ENGINE_TOKEN="${SCRAPER_ENGINE_TOKEN:-ortus2026scraper}"
ENGINE_REPO="/Users/antoniovarlese/ortus-salesnav-scraper-cloud"
PF_PID=""
ELECTRON_PID=""

cleanup() {
  trap - EXIT INT TERM
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  [ -n "$ELECTRON_PID" ] && kill "$ELECTRON_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

image_tag() {
  local namespace="$1"
  local image
  image="$(kubectl -n "$namespace" get deploy/"$DEPLOYMENT" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="app")].image}')" || return 1
  printf '%s' "${image##*:}"
}

start_port_forward() {
  kubectl -n "$DEV_NAMESPACE" port-forward deploy/"$DEPLOYMENT" \
    "$LOCAL_ENGINE_PORT:3000" >/tmp/ortus-dev-engine-port-forward.log 2>&1 &
  PF_PID=$!
}

engine_ready() {
  curl -fsS --max-time 5 -H "Authorization: Bearer $ENGINE_TOKEN" \
    "http://127.0.0.1:$LOCAL_ENGINE_PORT/api/health" >/dev/null 2>&1
}

# kubectl can need several seconds to resolve credentials and attach to a pod.
# Never kill a fresh tunnel merely because it was not ready within one 2s tick.
wait_for_tunnel() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    engine_ready && return 0
    kill -0 "$PF_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

DEV_VERSION="$(image_tag "$DEV_NAMESPACE")" || {
  echo "Could not read the development engine version. Run: gcloud auth login"
  exit 1
}
LIVE_VERSION="$(image_tag "$LIVE_NAMESPACE")" || {
  echo "Could not read the live engine version. Run: gcloud auth login"
  exit 1
}

# Electron must list profiles from the SAME GoLogin workspace as the dev engine.
# Loading the app's normal .env here would expose production profiles that the
# isolated engine correctly cannot open. Read only DEV_GOLOGIN_API_TOKEN and
# explicitly blank every secondary workspace token.
DEV_GOLOGIN_API_TOKEN="$(sed -n 's/^DEV_GOLOGIN_API_TOKEN=//p' "$ENGINE_REPO/.env" | tail -1)"
if [ -z "$DEV_GOLOGIN_API_TOKEN" ]; then
  echo "DEV_GOLOGIN_API_TOKEN is missing from $ENGINE_REPO/.env"
  echo "The development app will not start with production GoLogin profiles."
  exit 1
fi

echo "Development Electron"
echo "  app worktree: $(pwd)"
echo "  dev engine:   $DEV_VERSION"
echo "  live engine:  $LIVE_VERSION"

start_port_forward

# Wait for the first tunnel before Electron starts polling the engine.
if ! wait_for_tunnel; then
  echo "Could not establish the development-engine tunnel."
  tail -20 /tmp/ortus-dev-engine-port-forward.log 2>/dev/null || true
  exit 1
fi

env \
  SCRAPER_ENGINE_URL="http://127.0.0.1:$LOCAL_ENGINE_PORT" \
  SCRAPER_ENGINE_TOKEN="$ENGINE_TOKEN" \
  SCRAPER_ENGINE_VERSION="$DEV_VERSION" \
  PRODUCTION_ENGINE_VERSION="$LIVE_VERSION" \
  GOLOGIN_API_TOKEN="$DEV_GOLOGIN_API_TOKEN" \
  GOLOGIN_API_TOKEN_LINKEDVELOCITY="" \
  GOLOGIN_API_TOKEN_MARKETING="" \
  node_modules/.bin/electron . &
ELECTRON_PID=$!

# Keep the tunnel alive for the lifetime of Electron. A Deployment port-forward
# is tied to one pod, so any rollout/preemption requires a fresh connection.
FAILED_HEALTH_CHECKS=0
while kill -0 "$ELECTRON_PID" 2>/dev/null; do
  if kill -0 "$PF_PID" 2>/dev/null && engine_ready; then
    FAILED_HEALTH_CHECKS=0
  else
    FAILED_HEALTH_CHECKS=$((FAILED_HEALTH_CHECKS + 1))
  fi
  # Tolerate two missed checks. A busy API or brief network wobble should not
  # turn one usable tunnel into an endless kill/reconnect cycle.
  if [ "$FAILED_HEALTH_CHECKS" -ge 3 ]; then
    echo "Dev engine tunnel disconnected; reconnecting…"
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
    start_port_forward
    if wait_for_tunnel; then
      FAILED_HEALTH_CHECKS=0
      echo "Dev engine tunnel reconnected."
    fi
  fi
  sleep 2
done

wait "$ELECTRON_PID" 2>/dev/null || true
