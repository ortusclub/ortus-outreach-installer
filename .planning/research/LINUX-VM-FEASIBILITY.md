# Linux VM Feasibility — Ortus Outreach

**Researched:** 2026-04-21
**Scope:** Can the current Electron+Node tool run headless/headed on a Linux VM, with colleagues accessing the dashboard over HTTPS?
**Verdict:** **Yes, confirmed feasible.** GoLogin officially supports this deployment shape.

---

## Executive answer

Moving Ortus Outreach to a Linux VM is **technically feasible and officially documented by GoLogin**. The Node/Express backend (`server.js`) is already pure Node — it only talks to GoLogin via HTTP + a WebSocket URL — so Linux is a drop-in. GoLogin themselves publish two canonical Linux deployments: an [official Docker image](https://github.com/gologinapp/docker) (Ubuntu 20.04 + Xvfb) and a [VNC guide](https://github.com/gologinapp/gologin-vnc-guide) (Ubuntu + TigerVNC + XFCE). Both use the Linux build of Orbita Browser from `https://orbita-browser-linux.gologin.com/orbita-browser-latest.tar.gz` and run it **headed inside a virtual display** — not `--headless`. Each GoLogin profile continues to use its bound proxy, so LinkedIn sees the same residential IP it always has; the VM's own IP never talks to LinkedIn.

There is **one genuine unknown** that could not be resolved from web research alone: whether LinkedIn specifically detects a delta between the same GoLogin profile run from a Mac vs. from a Linux VM. GoLogin's fingerprint spec stores the profile's target OS (`win`/`mac`/`lin`) and Orbita spoofs the navigator accordingly, so in principle the profile's outward-facing fingerprint is consistent regardless of host OS — but this should be pilot-tested on one account before migrating the fleet, not taken on faith.

Recommendation: **Hetzner CX32 (4 vCPU / 8 GB RAM, €6.80/mo)** for the 5-profile target. Dashboard exposed via **Cloudflare Tunnel** (free, no public IP, no firewall config) with Cloudflare Access as an auth layer on top of the existing cookie-session login. Estimated one-time setup: half a day for someone who has used `apt` and `systemctl` before.

---

## 1. GoLogin-on-Linux verdict

**Verified.** The `gologin@2.2.8` SDK bundled in this repo has first-class Linux support baked into the code itself.

### Evidence from the installed SDK

`node_modules/gologin/src/browser/browser-checker.js:116-130`:

```js
getBrowserDownloadUrl(majorVersion) {
  const os = getOS();
  switch (os) {
    case 'mac':     return `https://orbita-browser-mac.gologin.com/...`;
    case 'win':     return `https://orbita-browser-windows.gologin.com/...`;
    case 'macM1':   return `https://orbita-browser-mac-arm.gologin.com/...`;
    case 'linArm':  return `https://orbita-browser-linux-arm.gologin.com/...`;
    default:        return `https://orbita-browser-linux.gologin.com/orbita-browser-latest-${majorVersion}.tar.gz`;
  }
}
```

Linux x86_64 and Linux ARM each have a dedicated Orbita binary hosted on GoLogin's CDN. On `process.platform === 'linux'` the SDK downloads and extracts it on first `GL.start()` into `~/.gologin/browser/orbita-browser-<majorVersion>/`, and the Chromium executable is named `chrome` (`browser-checker.js:112`).

`node_modules/gologin/src/gologin.js:505-511` also explicitly handles the case where a profile's target OS (`profileOs = 'lin'`) matches the host OS — this is the SDK's "same OS" fast path, not a second-class code path.

### Evidence from GoLogin's own repos

- **[gologinapp/docker](https://github.com/gologinapp/docker)** — Ubuntu 20.04 base, installs Xvfb + Orbita from the same Linux CDN URL, runs Orbita inside the virtual display. This is GoLogin's own production image.
- **[gologinapp/gologin-vnc-guide](https://github.com/gologinapp/gologin-vnc-guide)** — explicitly documented: "xvfb also supported but vnc scenario is recommended" — either works.
- **[GoLogin Linux documentation](https://gologin.com/docs/getting-started/setup/supported-platforms-installation)** — officially lists Ubuntu and Mint as supported; documents the `chrome-sandbox` chmod 4755 fix and the `libfuse2` dependency for the AppImage.

### Per-profile proxies, fingerprint spoofing, cookie sync — all preserved

- **Proxies**: the SDK reads `profile.proxy` from the GoLogin API and passes it to Orbita via `--proxy-server=...` (`gologin.js:930-931`). This is orthogonal to host OS.
- **Fingerprint spoofing**: the profile's stored `navigator`, `fonts`, `webgl`, `canvas` etc. are applied inside Orbita's Chromium fork via `orbita.config` (`gologin.js:688-697`). The Linux host does not leak into the fingerprint unless the profile itself is configured for Linux. If your profiles are `"os": "mac"` or `"os": "win"`, Orbita continues to present them as such on a Linux host — confirmed by the fact that `createProfileWithCustomParams` in the SDK README explicitly demonstrates creating a `"lin"` profile with a Linux user-agent on any host.
- **Cookie persistence**: `GL.start()` downloads cookies from GoLogin's S3 into the local profile; `GL.stop()` archives and uploads them back (`gologin.js:397, archiveProfile`). This pipeline is host-agnostic.

### Headless vs virtual display on Linux

`--headless` is technically supported by the SDK — GoLogin's own test suite uses `extra_params: ['--headless', '--no-sandbox']` against iphey.com's fingerprint-trust checker — but there are two reasons to prefer Xvfb/VNC over `--headless` for LinkedIn:

1. **Documented bug with proxy + headless**: GoLogin issue [#24](https://github.com/gologinapp/gologin/issues/24) reports pages failing to render when headless and proxy are combined ("background white"). This is unresolved as of the issue's last visible activity. Our workflow requires proxy + we navigate LinkedIn, so we hit this combination directly.
2. **LinkedIn detection surface**: modern anti-bot vendors add checks that fire only under `--headless` (e.g., `HeadlessChrome` in user-agent, different WebGL renderer) even in the new `chrome --headless=new` mode. Running headed under Xvfb sidesteps every one of those checks because from Chromium's point of view, there's a real X display.

**Both GoLogin reference setups use Xvfb/VNC, not `--headless`.** We should do the same.

---

## 2. Fingerprint / detection risk

This is the question that cannot be fully answered from public sources and where we should resist guessing.

### What GoLogin controls (known)

Orbita is a Chromium fork whose entire job is to replace every fingerprint surface the standard Chromium stack exposes with the values stored in the profile JSON. These surfaces include:

- `navigator.platform`, `navigator.userAgent`, `navigator.hardwareConcurrency`, `navigator.deviceMemory`
- `screen.width/height`, `window.innerWidth/innerHeight`
- WebGL `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL`
- Canvas noise injection
- AudioContext fingerprint
- Font enumeration (Orbita ships its own font list; the Docker image copies `/fonts` into `~/.gologin/browser/fonts`)
- Timezone (derived from proxy IP, applied via `--tz=` flag, `gologin.js:962`)

If a profile is configured as `"os": "mac"`, Orbita presents macOS values for every one of these regardless of whether it's running on Windows, macOS, or Linux. That's the entire product. Source: [GoLogin Orbita announcement](https://gologin.com/blog/meet-the-new-antidetect-browser-orbita/) and the SDK's `navigator`/`fonts` handling in `gologin.js`.

### What I could not verify

**Whether LinkedIn looks for subtle host-OS tells that Orbita doesn't cover.** Examples of things that could theoretically leak:

- TLS handshake (JA3/JA4) fingerprint — determined by the TLS library Chromium is built against, which could differ between macOS and Linux builds of Orbita.
- Low-level rendering differences in WebGL that the per-profile UNMASKED strings don't capture (anti-fraud vendors do sometimes render test shaders and hash the pixel output).
- Behavioural side-channels under Xvfb — e.g., `requestAnimationFrame` callback timing profile may differ from a real display.

I found **zero specific public reports** of "GoLogin profile used from Mac then from Linux → account challenged." Forums that discuss GoLogin + LinkedIn (Reddit, G2, TrustRadius) complain about proxy quality and resource consumption, not host-OS detection. Absence of reports is not proof of safety, but the risk is diffuse.

**Mitigation: pilot. Move one account to the VM for 7 days. If no challenges fire, the architecture is safe for the rest of the fleet.** This matches the de-risking approach already recorded in `CLOUD-EXECUTION-PROPOSAL.md`.

### What is definitely safe

The LinkedIn-facing IP does not change. Each GoLogin profile is bound to its own residential proxy; the proxy is terminated inside Orbita per profile (`--proxy-server=...`). The VM's IP never appears in LinkedIn traffic. This is the critical safety point and it holds regardless of host OS.

---

## 3. Proxy behavior

**Confirmed unchanged on Linux.** `gologin.js:927-932`:

```js
let { proxy } = this;
let proxy_host = '';
if (proxy) {
  proxy_host = this.proxy.host;
  proxy = `${proxy.mode}://${proxy.host}:${proxy.port}`;
}
```

The proxy is loaded from the profile's stored config (synced from GoLogin's API via `GL.getProfile()`), formatted into a URL, and passed to Orbita's `--proxy-server=` flag at spawn time. Nothing in this code path is OS-conditional. LinkedIn sees the proxy IP, not the VM IP.

Auth credentials for authenticated proxies are handled by Orbita itself (the SDK passes them via the proxy URL, and the upstream proxy provider handles the rest). This also does not change.

---

## 4. Multi-user dashboard access

The existing dashboard (`server.js` + `src/auth.js`) already has cookie-session auth backed by `data/users.json` and emails whitelisted against the State of Operations sheet. That stack works unchanged on Linux — it's just Express + cookie-parser + bcryptjs. What we're adding is a way for browsers on other laptops to reach it.

### Two viable paths, both better than opening a port

**Option A — Cloudflare Tunnel (recommended).** [docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

- **Cost**: free forever (up to 50 users on Cloudflare Access).
- **No public IP required**. No DNS record beyond a CNAME on a Cloudflare-managed zone.
- **No ports opened on the VM**. `cloudflared` establishes an outbound-only QUIC connection to Cloudflare's edge; Cloudflare routes `https://ortus-outreach.<your-domain>.com` → tunnel → `http://localhost:3000` on the VM.
- Install: `cloudflared service install <token>` (one command after creating the tunnel in the dashboard).
- Optional: add Cloudflare Access rules to require Google SSO on top of the existing cookie auth — defence in depth, no code changes.

This is the clear winner for our use case because (a) the budget is tight, (b) nobody wants to manage Let's Encrypt renewals, and (c) we don't need a public IP.

**Option B — Caddy + Let's Encrypt + VM firewall.**

- **Cost**: $0 for the software, but requires a domain (~$12/yr on Cloudflare/Namecheap) and the VM must have ports 80+443 open.
- Caddy handles ACME automatically — [docs](https://caddyserver.com/docs/automatic-https). Four-line Caddyfile:
  ```
  outreach.ortusclub.com {
      reverse_proxy localhost:3000
  }
  ```
- We manage firewall rules (`ufw allow 80, 443`), DNS (`A` record pointing to the VM IP), certificate renewal monitoring.

Caddy is lighter operationally than nginx for a single-service VM but heavier than Cloudflare Tunnel. Only pick this if the team has an allergy to Cloudflare.

**Do not** put the VM's IP and port 3000 directly in the firewall. Node/Express without TLS in front of it is not what we want session cookies riding over.

---

## 5. VM sizing

### Memory budget per Chromium (empirical, from this codebase)

`src/gologin-launcher.js:62-72` already applies aggressive per-Chromium memory flags:

```js
'--disable-extensions',
'--disable-background-networking',
'--disable-features=TranslateUI,MediaRouter',
'--disable-renderer-backgrounding',
'--renderer-process-limit=2',
'--js-flags=--max-old-space-size=512',
```

With these flags, each active Orbita profile holding LinkedIn open uses **~500–700 MB RAM** on macOS. Linux will be slightly lower (no WindowServer overhead). Plus:

- Node process: ~150 MB
- Xvfb (one display): ~40 MB
- Ubuntu base + systemd + ssh: ~200 MB
- `cloudflared`: ~30 MB
- Headroom for apt, logs, cron, kernel cache: ~1 GB

### Recommended specs

| Concurrent profiles | Total RAM need | Recommended VM | Monthly | Provider |
|---|---|---|---|---|
| **3 profiles** (typical) | ~3.0 GB | **Hetzner CX22** — 2 vCPU / 4 GB / 40 GB | **€3.79** | [Hetzner](https://www.hetzner.com/cloud) |
| **5 profiles** (max) | ~4.8 GB | **Hetzner CX32** — 4 vCPU / 8 GB / 80 GB | **€6.80** | [Hetzner](https://www.hetzner.com/cloud) |
| Same, on DO | ~4.8 GB | **DO Basic 8GB/4CPU** | **$48** | [DigitalOcean](https://www.digitalocean.com/pricing/droplets) |
| Same, on DO (tighter) | ~4.8 GB | DO Basic 4GB/2CPU — will swap under 5 profiles | $24 | DigitalOcean |

**Pick Hetzner CX32.** It fits the 5-profile peak with headroom, is cheaper than any comparable DigitalOcean tier, and has European billing aligned with Ortus's jurisdiction. DigitalOcean is 7× more expensive at the relevant tier. ([Hetzner CX pricing](https://www.hetzner.com/news/new-cx-plans/), [DO pricing](https://www.digitalocean.com/pricing/droplets))

Bandwidth: LinkedIn pages average ~3–5 MB per profile visit, times ~40 leads × 5 profiles × 22 workdays = ~22 GB/month. Well under the 20 TB Hetzner includes on any CX plan.

Disk: `data/` today is <1 MB. Orbita cold-start downloads ~150 MB. Node_modules ~200 MB. 40 GB is far more than we need.

---

## 6. Session / cookie persistence

**Confirmed unchanged on Linux.** The cookie flow is:

1. `GL.start()` — SDK downloads the profile archive from GoLogin's S3 (includes cookies), extracts into local profile dir (`gologin.js:529, downloadProfileAndExtract`).
2. Campaign runs, Chromium writes to the profile's cookies DB.
3. `GL.stop()` — SDK archives profile and uploads back to GoLogin's storage (`gologin.js:1454+`).

Nothing here depends on host OS. This is the critical point for the "Mac offline, VM online" handoff — when a profile is next used on the VM, it pulls the most recent cookie set from GoLogin's cloud. If the same profile is later used from a Mac again (e.g., for manual browsing), it pulls whatever the VM uploaded. GoLogin's cloud is authoritative.

**One caveat**: don't run the same profile concurrently on two hosts. The second `GL.start()` will race the first's upload on `GL.stop()` and the losing side will have a stale cookie view. Our architecture already enforces one-campaign-at-a-time via `campaign.running` flag in `src/campaign.js:122`, so this is a non-issue. But: if a colleague is manually browsing a profile from the desktop GoLogin app while the VM is also running a campaign with it, **that** would be a problem. Policy, not code, solves this — document it.

---

## 7. Operational concerns

### Security updates without surprise reboots

Ubuntu 24.04 ships `unattended-upgrades` enabled by default for security packages. Auto-reboot is **already off by default** — `Unattended-Upgrade::Automatic-Reboot "false"` ([Ubuntu docs](https://ubuntu.com/server/docs/how-to/software/automatic-updates/)). Leave it. A weekly manual reboot after a 30-second systemd service restart is fine — and safer than the VM rebooting mid-campaign.

If a kernel security patch needs a reboot, the system drops a `/var/run/reboot-required` marker. Monitor for it via UptimeRobot or a simple cron:

```cron
0 9 * * 1  [ -f /var/run/reboot-required ] && mail -s "Ortus VM needs reboot" antonio@ortusclub.com < /var/run/reboot-required
```

### GoLogin SDK updates

`gologin@2.2.8` is pinned in `package.json`. Don't auto-upgrade. When a new Orbita major version ships, GoLogin increments a version number in its API; the SDK's `checkBrowser()` pulls the matching binary. So the SDK version in node_modules and the Orbita binary version are **decoupled** — Orbita updates roll out via the SDK calling `browser-checker.downloadBrowser()` on first profile launch after a version bump.

This means: even without upgrading the gologin npm package, Orbita will auto-update to match whatever version LinkedIn expects (roughly once a month based on the [Orbita changelog](https://useorbita.com/)). The failure mode if Orbita falls behind Chrome's real version is a user-agent mismatch that LinkedIn can detect. GoLogin's job is to keep this from happening; ours is to not pin Orbita.

### Monitoring — minimum viable

**UptimeRobot free tier** (50 monitors, 5-min interval): add one monitor hitting `https://<tunnel-url>/api/health` — already implemented at `server.js:180`. Sends email/SMS on 503 or timeout.

**That's it.** Don't build more until there's a real outage to learn from. The campaign itself already emails the owner on start/finish/failure (`server.js:401-414`).

### Backup

`data/` is the one thing that matters:

- `state.json` — processed URL set (regenerable by re-scanning Sheet, but a day's work lost)
- `history.json` — campaign history (nice-to-have)
- `templates.json`, `presets.json`, `schedules.json` — user config (real user pain if lost)
- `users.json` — bcrypt password hashes
- `local-profile/` — logged-in local Chromium session (tiny, not critical; GoLogin profiles are in the cloud already)

```bash
# /etc/cron.daily/ortus-backup
#!/bin/sh
tar -czf /var/backups/ortus-data-$(date +%Y%m%d).tar.gz -C /opt/ortus-outreach data
find /var/backups/ -name 'ortus-data-*.tar.gz' -mtime +14 -delete
```

Off-host copy via `rclone sync /var/backups/ gdrive:OrtusBackups/` (gdrive token goes in SOPS or a separate systemd environment file).

---

## 8. Scheduling (node-cron)

`server.js:594-700` uses `node-cron@4.2.1` for scheduled campaigns, with schedules persisted in `data/schedules.json`. `node-cron` runs entirely in-process — it's just JavaScript that checks the current time against an expression. This **works identically on Linux**; no system-level cron involved.

**Recommendation: keep `node-cron`, don't migrate to `systemd` timers.** Reasons:

1. The scheduler already works and persists across restarts (server loads schedules on startup: `server.js:837-840`).
2. Schedules are created/edited from the dashboard UI via `POST /api/schedules`. Migrating to systemd timers would require writing a UI → systemd-unit-file generator, which is an enormous downgrade.
3. `node-cron` survives the VM reboot because the Node process is managed by systemd/pm2 (see below) and reloads schedules on startup.

The only thing that changes vs Mac: we need a process manager to make sure the Node process auto-starts after reboots. Two options:

- **systemd** (recommended, zero extra deps): one `.service` file, `systemctl enable ortus-outreach`. Logs go to journald. See migration runbook below.
- **pm2**: familiar but adds an npm dep. `pm2 startup && pm2 save`. Slightly nicer log tailing. Not worth the extra moving part.

---

## 9. Migration runbook

Fresh **Ubuntu 24.04 LTS** on Hetzner CX32. All commands assume root or sudo.

### Step 1 — base system
```bash
apt update && apt upgrade -y
apt install -y curl git build-essential
# Create a non-root user for the app (don't run Chromium as root)
adduser --disabled-password --gecos "" ortus
usermod -aG sudo ortus
```

### Step 2 — Node 20 (gologin requires >=20)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v   # expect v20.x
```

### Step 3 — Chromium/Orbita runtime deps
Taken from [gologinapp/docker/Dockerfile](https://github.com/gologinapp/docker/blob/master/Dockerfile):
```bash
apt install -y \
  xvfb fonts-liberation \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 \
  libexpat1 libfontconfig1 libgbm1 libgtk-3-0 libglib2.0-0 \
  libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 \
  libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
  libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
  libasound2t64 libappindicator3-1 libcurl3-gnutls xdg-utils ca-certificates
```

Note `libasound2` was renamed `libasound2t64` in Ubuntu 24.04. If you see "package not found" errors, it's because you're on an older Ubuntu — prefer 24.04.

### Step 4 — clone + install
```bash
sudo -u ortus bash <<'EOF'
cd ~
git clone https://github.com/ortusclub/ortus-gologin-clone.git  # or scp the dir
cd ortus-gologin-clone
npm ci --omit=dev   # skips electron/electron-builder — we don't need them
EOF
```

Drop in the `.env` (same keys as on the Mac: `GOLOGIN_API_TOKEN`, `SHEETS_WEBAPP_URL`, SMTP creds, `PORT=3000`) at `/home/ortus/ortus-gologin-clone/.env`.

### Step 5 — fix chrome-sandbox (one-time, after first `GL.start()`)
First campaign run will download Orbita to `~/.gologin/browser/orbita-browser-<version>/`. Then once:
```bash
sudo chown root:root /home/ortus/.gologin/browser/orbita-browser-*/chrome-sandbox
sudo chmod 4755 /home/ortus/.gologin/browser/orbita-browser-*/chrome-sandbox
```
Alternative: pass `--no-sandbox` via `extra_params` in `src/gologin-launcher.js` (we already pass a bunch). But sandbox on is safer — prefer the chmod.

### Step 6 — Xvfb under systemd
`/etc/systemd/system/xvfb.service`:
```ini
[Unit]
Description=Xvfb virtual display for Orbita
After=network.target

[Service]
User=ortus
ExecStart=/usr/bin/Xvfb :99 -screen 0 1366x900x24
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now xvfb
```

### Step 7 — Ortus Outreach service
`/etc/systemd/system/ortus-outreach.service`:
```ini
[Unit]
Description=Ortus Outreach (GoLogin dashboard + campaign runner)
After=network.target xvfb.service
Requires=xvfb.service

[Service]
User=ortus
WorkingDirectory=/home/ortus/ortus-gologin-clone
Environment=DISPLAY=:99
Environment=NODE_ENV=production
EnvironmentFile=/home/ortus/ortus-gologin-clone/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now ortus-outreach
journalctl -u ortus-outreach -f   # confirm it boots
curl http://127.0.0.1:3000/api/health   # expect {"ok":true}
```

### Step 8 — Cloudflare Tunnel (recommended)
```bash
# On Cloudflare dashboard: Networks → Tunnels → Create → name it "ortus-outreach"
# Copy the cloudflared install command it gives you, run on the VM:
curl -L https://pkg.cloudflare.com/cloudflared/deb-src/... | ...   # (exact command from dashboard)
cloudflared service install <TOKEN_FROM_DASHBOARD>

# On Cloudflare dashboard: Public Hostnames → Add:
#   Subdomain: outreach
#   Domain:    ortusclub.com
#   Service:   http://localhost:3000
```

That's it. `https://outreach.ortusclub.com` now routes to the VM. Optionally add Cloudflare Access: **Access → Applications → Add → Self-hosted**, require Google SSO from `@ortusclub.com` emails.

### Step 9 — first launch + pilot
Log in from the dashboard, trigger one campaign with **one account**. Watch `journalctl -u ortus-outreach -f`. On first run, Orbita downloads (~150 MB, ~30 seconds) then the campaign proceeds as normal. Watch for a week. If no LinkedIn challenges fire for that account, roll the rest.

### Known gotchas

- **Ubuntu 22.04 vs 24.04**: on 22.04, use `libasound2`; on 24.04, use `libasound2t64`.
- **`chown root:root chrome-sandbox`** must be re-run each time Orbita auto-updates to a new major version (directory name changes). Consider a systemd path unit that watches `~/.gologin/browser/` for new subdirectories and fixes perms — or just script `chown/chmod` into a weekly cron.
- **Tunnel + health check**: Cloudflare proxies close idle connections at 100 seconds. The dashboard's long-poll/SSE log streaming (`/api/campaign/status` is polled every 2 s in current UI, so this is fine) — but if we ever add websockets, we need `--edge-tunnel-ip-family ipv4` and to be aware of this limit.
- **Time zone mismatch**: the VM default TZ is UTC. `node-cron` schedules fire based on the server's TZ. Existing `data/schedules.json` entries were created from Europe/London/UTC+1. Set `TZ=Europe/London` in the systemd `Environment=` if that matters.

---

## 10. Architecture (before → after)

### Before — Electron on Mac
```
┌───────── macOS ──────────┐
│                          │
│   Electron BrowserWindow │
│          ↓  (loads)      │
│   http://127.0.0.1:<port>│
│          ↓               │
│   Express (server.js)    │
│          ↓               │
│   gologin-launcher.js    │──► GoLogin Cloud API (profile sync, cookies)
│          ↓               │         ▲
│   Orbita Chromium × 2–5  │         │
│   (in ~/.gologin/...)    │         │
│          ↓               │         │
│   per-profile proxy ─────┼─► residential IP ──► LinkedIn
│                          │
└──────────────────────────┘
Reachable only from this Mac.
```

### After — Linux VM
```
                                          ┌──────── Cloudflare Edge ────────┐
Colleague's laptop (anywhere) ───HTTPS──► │  outreach.ortusclub.com         │
                                          │  (optional: Access SSO gate)    │
                                          └──────────────┬──────────────────┘
                                                         │  cloudflared tunnel
                                                         ▼  (outbound, no inbound port)
┌────────────── Hetzner CX32 (Ubuntu 24.04) ─────────────────────────────────┐
│                                                                            │
│   systemd → xvfb.service (Xvfb :99)                                        │
│   systemd → ortus-outreach.service                                         │
│                │                                                           │
│                ├─► Express (server.js)                                     │
│                │   - /api/me, /api/campaign/start, schedules, presets...   │
│                │   - cookie-session auth backed by data/users.json         │
│                │                                                           │
│                ├─► node-cron (in-process, reads data/schedules.json)       │
│                │                                                           │
│                └─► gologin-launcher.js                                     │
│                        │                                                   │
│                        ├─ GL.start() → downloads profile from GoLogin S3   │
│                        │                                                   │
│                        └─► Orbita Chromium × 2–5 (DISPLAY=:99)             │
│                                │                                           │
│                                └─► per-profile proxy ─► residential IP ──► LinkedIn
│                                                                            │
│   data/ (state, history, users, templates, presets, schedules)             │
│      ↓                                                                     │
│   /etc/cron.daily → tar + rclone to Google Drive                           │
└────────────────────────────────────────────────────────────────────────────┘
```

Team access: web-based, any browser, no Mac required.

---

## 11. Risks & unknowns

| # | Item | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | **Host-OS fingerprint delta** — unverifiable that LinkedIn doesn't detect "same profile from different host OS" | Medium, but no public evidence it's a problem | Pilot with one account for a week before fleet rollout. GoLogin's architecture says this shouldn't matter; the pilot confirms it empirically. |
| 2 | `chrome-sandbox` permission breaks on Orbita major-version upgrade | Low | Cron or systemd path unit to re-apply `chown/chmod`; or ship with `--no-sandbox` and accept the minor isolation loss. |
| 3 | Concurrent profile use (VM campaign + someone manually opening same profile on Mac) could corrupt the cookie DB | Low, policy-controllable | Document: "Don't open a profile in desktop GoLogin while the VM is running a campaign." |
| 4 | Orbita headless+proxy white-screen bug ([gologin#24](https://github.com/gologinapp/gologin/issues/24)) | N/A if we use Xvfb (recommended) | Don't use `--headless` on Linux. Use Xvfb. |
| 5 | VM disk fills with Orbita logs / downloaded profiles | Low | 80 GB is plenty for our usage; but add `logrotate` for `/home/ortus/.gologin/logs` if one exists. |
| 6 | Cloudflare Tunnel outage blocks team from dashboard | Low | Cloudflare SLA is 99.99%; campaigns keep running on the VM even if the tunnel is down. Worst case: SSH to the VM and check status directly. |
| 7 | Hetzner CX32 IPv4 is a data-center block — if any proxy ever fails and Chromium falls back to host IP, LinkedIn sees a DC IP | **Critical** | Audit `src/gologin-launcher.js` and confirm we never fall back to direct connection if the proxy is misconfigured. Current code passes proxy through GoLogin profile only — no fallback path exists. Verify post-migration. |
| 8 | Team's GoLogin plan may limit concurrent Linux profile launches | Unknown | Confirm with GoLogin support that current plan supports 5 concurrent SDK launches from a single host. (This is different from Cloud Launcher.) |

Items 1, 7, and 8 should be explicitly resolved before the cutover, not after.

---

## 12. Sources

All technical claims in this document trace to one of:

**Installed SDK source (primary):**
- `/Users/antoniovarlese/ortus-gologin-clone/node_modules/gologin/src/gologin.js` — lines 43, 505–511, 919–967, 927–932 (proxy handling)
- `/Users/antoniovarlese/ortus-gologin-clone/node_modules/gologin/src/browser/browser-checker.js` — lines 18–28, 102–130 (Linux Orbita download URLs)
- `/Users/antoniovarlese/ortus-gologin-clone/node_modules/gologin/src/utils/common.js` — getOS() Linux branch
- `/Users/antoniovarlese/ortus-gologin-clone/node_modules/gologin/run.sh` — DISPLAY-based launch

**This codebase:**
- `package.json` — gologin 2.2.8, puppeteer-core 22.15.0, node-cron 4.2.1
- `src/gologin-launcher.js:62-72` — memory-reducing flags already in place
- `src/campaign.js:56-72` — host-resource preflight
- `server.js:43-149` — existing cookie-session auth (Linux-portable as-is)
- `electron/main.js` — confirms Electron is a thin wrapper around `server.js`

**GoLogin's own Linux reference material:**
- [gologinapp/docker Dockerfile](https://github.com/gologinapp/docker/blob/master/Dockerfile) — canonical Ubuntu+Xvfb+Orbita setup
- [gologinapp/docker entrypoint.sh](https://github.com/gologinapp/docker/blob/master/entrypoint.sh) — Xvfb bootstrap sequence
- [gologinapp/gologin-vnc-guide README](https://github.com/gologinapp/gologin-vnc-guide/blob/master/README.md) — VPS + VNC setup with exact commands
- [GoLogin docs: supported platforms](https://gologin.com/docs/getting-started/setup/supported-platforms-installation) — Ubuntu/Mint support, chrome-sandbox perms
- [GoLogin Orbita announcement](https://gologin.com/blog/meet-the-new-antidetect-browser-orbita/) — fingerprint-spoofing scope

**Known issues referenced:**
- [gologin#24 — headless+proxy white screen](https://github.com/gologinapp/gologin/issues/24)
- [gologin#29 — chrome-sandbox PermissionError](https://github.com/gologinapp/gologin/issues/29)

**Infrastructure pricing (April 2026):**
- [Hetzner Cloud CX plans](https://www.hetzner.com/cloud)
- [Hetzner new CX plans announcement](https://www.hetzner.com/news/new-cx-plans/)
- [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets)

**Infrastructure docs:**
- [Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Ubuntu unattended-upgrades](https://ubuntu.com/server/docs/how-to/software/automatic-updates/)

**LinkedIn detection context (cross-checked, not sole source):**
- [Konnector — LinkedIn Automation Detection](https://konnector.ai/linkedin-headless-browsers/)
- [Security Boulevard — anti-detect framework evolution 2025](https://securityboulevard.com/2025/06/from-puppeteer-stealth-to-nodriver-how-anti-detect-frameworks-evolved-to-evade-bot-detection/)
