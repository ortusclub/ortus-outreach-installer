# Running the app against the development engine

**Anyone working from this repository should be on the development engine, not
production.** A source build talks to production by default, and nothing on
screen shouts about it, so this is easy to get wrong for weeks.

There are two engines:

| | Namespace | Image | Who it serves |
|---|---|---|---|
| **Production** | `salesnav-scraper` | `vNNN` | The team's real campaigns, via `https://scraper.ortusclub.com` |
| **Development** | `salesnav-dev` | `dev-N` | Developers only. Its own Postgres and Redis. |

The development engine has **no public address** — its Service is ClusterIP with
no ingress, by design. The only way in is a `kubectl port-forward`, which
`scripts/electron-dev-vm.sh` opens and keeps alive for you.

## Am I on it?

The launcher prints this at boot:

```
Development Electron
  dev engine:   dev-14
  live engine:  v139
  tunnel auth:  service account (does not expire)
```

`dev engine:` is what you are talking to. If you started the app with
`npm run dev:app` instead, you are on **production** — that path never sets
`SCRAPER_ENGINE_URL`, so it falls back to the hardcoded production URL in
`src/scraper-engine-url.js`. `GET /api/health` says the same thing in
`scraperEngineEnvironment`.

## Setup

You need `kubectl` (`brew install kubectl`). You do **not** need gcloud, a
Google account, or any access to the GCP project — the tunnel authenticates with
a Kubernetes ServiceAccount token, which the cluster issues rather than Google.

Ask Antonio for the tunnel credential. He generates the paste line with
`scripts/dev-tunnel-handoff.sh` and sends it privately; it installs
`~/.kube/ortus-dev.yaml` and immediately proves the connection works.

Then launch with:

```sh
scripts/electron-dev-vm.sh
```

That is the whole setup. The credential does not expire, so it survives reboots
and closed lids.

## Why not just use your gcloud login

It expires nightly under the Workspace session policy. When it does, the
supervisor cannot reopen the tunnel, and the app keeps showing whatever the VM
last said — measured 2026-08-28 as a campaign card frozen at 01:27 and still
counting down to a 02:08 check at 09:11, while the engine had in fact swept
normally at 03:10, 05:10 and 07:10. The card now says it has lost the link after
90 seconds of silence, but a tunnel that cannot reconnect is still a dead tunnel.

## Administering the credential

Owner-only, from an authenticated gcloud session:

```sh
# create (once per ServiceAccount name)
kubectl apply -f ../ortus-salesnav-scraper-cloud/k8s-dev/30-tunnel-serviceaccount.yaml
scripts/dev-tunnel-kubeconfig.sh          # writes ~/.kube/ortus-dev.yaml
scripts/dev-tunnel-handoff.sh             # prints the line to send a developer

# revoke — cuts off EVERYONE using this ServiceAccount
kubectl -n salesnav-dev delete sa ortus-dev-tunnel
```

The token can list the development namespace and open a port-forward, and it is
refused when it tries to change anything. It can read the production
deployment's image tag, purely so the launcher can print `live engine: vNNN`,
and nothing else in production.

For per-person revocation, apply the manifest again under a second
ServiceAccount name and generate a separate credential for each developer.

## Deploying to the development engine

From the engine repository: `./deploy-dev.sh` builds a `dev-N` image and rolls
`salesnav-dev`. `./deploy.sh` is **production** — the two are never the same
command. Restart the app afterwards, because the launcher reads the image tag
once at boot.
