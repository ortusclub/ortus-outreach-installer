#!/usr/bin/env bash
# Deploy FG Auto-Pilot to GKE (fg-roster service :v2 + CronJob + IAM).
# Run from repo root:  bash scripts/deploy-fg-autopilot.sh
set -euo pipefail

NS=salesnav-scraper
GSA=fg-roster-reader@salesnav-scraper-prod.iam.gserviceaccount.com
BUCKET=ortus-fg-connections-db
IMG=asia-southeast1-docker.pkg.dev/salesnav-scraper-prod/salesnav-images/fg-roster:v2
URL=https://scraper.ortusclub.com/fg-roster
TOKEN=ortus2026scraper

echo "═══ 1/5  IAM — grant the roster service write access to its bucket ═══"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$GSA" --role="roles/storage.objectUser" --quiet

echo "═══ 2/5  Build the new image ($IMG) — a few minutes ═══"
gcloud builds submit --config services/fg-roster/cloudbuild.yaml . --quiet

echo "═══ 3/5  Roll the deployment to :v2 + apply the CronJob ═══"
kubectl apply -f k8s/fg-roster/deployment.yaml
kubectl apply -f k8s/fg-roster/cronjob.yaml

echo "═══ 4/5  Wait for the rollout ═══"
kubectl -n "$NS" rollout status deploy/fg-roster --timeout=180s

echo "═══ 5/5  Verify the new /admin/autopilot route answers with JSON ═══"
ok=0
for i in $(seq 1 40); do
  body="$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/admin/autopilot" || true)"
  if printf '%s' "$body" | grep -q '"runs"'; then
    echo "  ✓ live: $body"
    ok=1; break
  fi
  echo "  …not live yet (attempt $i) — waiting"; sleep 5
done
if [ "$ok" = 1 ]; then
  echo ""
  echo "✅ FG Auto-Pilot deployed. Open the FG board and: Run it now / toggle / Edit schedule now persist + fire."
  echo "   (Email alerts stay OFF until ALERT_EMAIL_TO + SMTP are added to the fg-roster secret.)"
else
  echo ""
  echo "⚠️  Deployed but the route didn't answer with JSON in time — check: kubectl -n $NS logs deploy/fg-roster --tail=40"
  exit 1
fi
