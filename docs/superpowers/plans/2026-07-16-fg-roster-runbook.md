# FG Roster — deploy runbook

Central roster service (`services/fg-roster/server.js`) serving the connections DB
to the cloud engine at `scraper.ortusclub.com/fg-roster`. This runbook is the
ordered deploy procedure. Steps 5 and 6 are **PROD and require explicit operator
approval** before running — everything else is prep/build.

Cluster context: `gke_salesnav-scraper-prod_asia-southeast1_salesnav-cluster`
Namespace: `salesnav-scraper`

## 1. GCS bucket + service account + Workload Identity

Create the bucket that holds the published connections DB, a Google Service
Account (GSA) with read-only access to it, and bind that GSA to the Kubernetes
Service Account (KSA) the Deployment runs as (`fg-roster`, matching
`deployment.yaml`'s `serviceAccountName`).

```bash
gcloud config set project salesnav-scraper-prod

# bucket
gsutil mb -l asia-southeast1 gs://ortus-fg-connections-db

# GSA with read-only access to the bucket
gcloud iam service-accounts create fg-roster-reader \
  --display-name="fg-roster GCS reader"

gsutil iam ch \
  serviceAccount:fg-roster-reader@salesnav-scraper-prod.iam.gserviceaccount.com:roles/storage.objectViewer \
  gs://ortus-fg-connections-db

# KSA in-cluster
kubectl create serviceaccount fg-roster -n salesnav-scraper

# Workload Identity binding: KSA fg-roster <-> GSA fg-roster-reader
gcloud iam service-accounts add-iam-policy-binding \
  fg-roster-reader@salesnav-scraper-prod.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:salesnav-scraper-prod.svc.id.goog[salesnav-scraper/fg-roster]"

kubectl annotate serviceaccount fg-roster -n salesnav-scraper \
  iam.gke.io/gcp-service-account=fg-roster-reader@salesnav-scraper-prod.iam.gserviceaccount.com
```

## 2. First publish — populate the bucket

Before the service can serve anything, push the local connections DB up once:

```bash
chmod +x scripts/publish-connections-db.sh   # see step 3, doing it here too since it's needed to run
./scripts/publish-connections-db.sh
```

Note: the `curl .../admin/refresh` call in the script will fail until the service
is actually deployed (step 5) — that's expected on this first run. The `gsutil`
sync/cp lines are what matters here; they seed the bucket.

## 3. Make the publish script executable

```bash
chmod +x scripts/publish-connections-db.sh
```

(Already done as part of step 2 above if followed in order; listed separately
here to match the checklist — safe to run again, idempotent.)

## 4. Build and push the image

Either let Cloud Build do it, or build+push locally:

```bash
# option A — Cloud Build
gcloud builds submit --tag asia-southeast1-docker.pkg.dev/salesnav-scraper-prod/salesnav-images/fg-roster:v1 .

# option B — local docker
docker build -f services/fg-roster/Dockerfile -t asia-southeast1-docker.pkg.dev/salesnav-scraper-prod/salesnav-images/fg-roster:v1 .
docker push asia-southeast1-docker.pkg.dev/salesnav-scraper-prod/salesnav-images/fg-roster:v1
```

## 5. Apply the k8s manifests — PROD, requires explicit operator approval

Do not run this without the operator's go-ahead. Copy the secret example, fill in
the real token, and apply everything (the real `secret.yaml` must never be
committed):

```bash
cp k8s/fg-roster/secret.example.yaml k8s/fg-roster/secret.yaml
# edit k8s/fg-roster/secret.yaml — set the real token

kubectl config use-context gke_salesnav-scraper-prod_asia-southeast1_salesnav-cluster
kubectl apply -f k8s/fg-roster/secret.yaml
kubectl apply -f k8s/fg-roster/
```

## 6. Patch the engine Ingress — PROD, requires explicit operator approval

The engine's Ingress lives in the **separate** repo
`~/Desktop/Projects/ortus-salesnav-scraper-cloud/k8s/05-ingress.yaml` (host
`scraper.ortusclub.com`, `ManagedCertificate: salesnav-cert`, static IP
`salesnav-ip`). This runbook does not edit that repo automatically — the
operator applies this snippet by hand, adding it to the `paths` list **before**
the existing `/` catch-all rule:

```yaml
          - path: /fg-roster
            pathType: Prefix
            backend: { service: { name: fg-roster, port: { number: 80 } } }
```

Then apply it from that repo:

```bash
kubectl config use-context gke_salesnav-scraper-prod_asia-southeast1_salesnav-cluster
kubectl apply -f k8s/05-ingress.yaml   # run from within ortus-salesnav-scraper-cloud
```

## 7. Smoke test

```bash
curl https://scraper.ortusclub.com/fg-roster/health
```

Expect a 200 with a health payload. If it 404s, check the Ingress path ordering
(step 6) — the catch-all `/` rule must come after `/fg-roster`, not before.

## FG Auto-Pilot add-on (2026-07-16)

1. **IAM — grant the service GCS write** (was read-only):
   ```bash
   gcloud storage buckets add-iam-policy-binding gs://ortus-fg-connections-db \
     --member="serviceAccount:fg-roster-reader@salesnav-scraper-prod.iam.gserviceaccount.com" \
     --role="roles/storage.objectUser"
   ```
2. **Secret — add SMTP + recipients** to `k8s/fg-roster/secret.yaml` (gitignored) per `secret.example.yaml`, then `kubectl apply -f k8s/fg-roster/secret.yaml`.
3. **Rebuild + roll the image** (now includes `services/fg-roster/{autopilot,mailer,config-store}.js` + `src/fg-autopilot.js`): rebuild via `services/fg-roster/cloudbuild.yaml`, bump the image tag, `kubectl set image`/`apply` the Deployment (with the new `envFrom`).
4. **CronJob:** `kubectl apply -f k8s/fg-roster/cronjob.yaml`.
5. **Verify:** `kubectl create job --from=cronjob/fg-autopilot fg-autopilot-manual -n salesnav-scraper` then `kubectl logs job/fg-autopilot-manual -n salesnav-scraper` — expect a JSON `{"skipped":true,"reason":"not-a-run-day"}` (unless run on the 1st/15th) or `no-pairs` before the app has published a config.
