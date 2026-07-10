# Engine-side spec: live "Show campaign happening" (campaign browser screencast)

**Audience:** whoever owns / deploys the engine at `https://scraper.ortusclub.com`.

**Goal:** let an operator watch a running **cloud campaign's** browser live, exactly
like the Sales Nav scrape "👁 View" already does. The engine **already has this
capability for scrapes** — this spec asks for the same, keyed by campaign.

---

## What already exists (scrape side — the template)

The engine streams a live MJPEG screencast of a running scrape job:

```
GET /api/scrape/view/:jobId
Authorization: Bearer <token>
→ 200  Content-Type: multipart/x-mixed-replace; boundary=…
       (a stream of JPEG frames captured via CDP Page.startScreencast)
→ 404  application/json  when the job isn't running / has no live page
```

The desktop app proxies it and renders it in an `<img>` — no polling, the browser
plays multipart/x-mixed-replace as live video natively (`server.js`
`/api/scrape/view/:jobId`, `app.js` `openScrapeJobView`).

## What's missing (campaign side)

There is **no** equivalent for campaigns. Confirmed by probing: every
`GET /api/campaign/:id/view` (and `/screencast`, `/screen`, `/sessions`) falls
through to the SPA (returns `text/html`), and a running campaign's browser
sessions do **not** appear in `/api/jobs` (that's scrape jobs only).

---

## The ask: `GET /api/campaign/:id/view`

Stream an MJPEG screencast of the campaign's **currently-active browser session**,
identical wire format to the scrape endpoint:

```
GET /api/campaign/:id/view[?account=<profileId>]
Authorization: Bearer <token>
→ 200  Content-Type: multipart/x-mixed-replace; boundary=…   (JPEG frames via CDP)
→ 404  application/json { error: "no active session" }        (not running / idle between sends)
```

Notes:
- **Which browser?** A campaign drives one browser **per GoLogin account**. Default
  to the session that's **actively sending right now**. Optionally honor
  `?account=<profileId>` to pick a specific account's browser (the app can add a
  picker later); without it, "the active one" is fine for v1.
- **Reuse the scrape screencast plumbing** — same CDP `Page.startScreencast` →
  multipart/x-mixed-replace encoder the scrape `/view` already uses. Start on
  first connect, stop when the client disconnects (the app aborts the `<img>`),
  same lifecycle as the scrape view.
- **Idle windows:** campaigns pause 30–60 s between sends. During a gap either keep
  streaming the last-active page or return `404 {error:"idle"}`; the app shows a
  small "waiting…" state and retries — either is fine.
- **Auth:** same Bearer as every other engine route.

## App side — already built and waiting

The desktop app (v2.154.0) already ships the whole client half:
- **Button:** `👁 Show` on every running cloud-campaign strip.
- **Proxy:** `GET /api/campaign/cloud/:id/view` → forwards to the engine's
  `/api/campaign/:id/view`, piping the stream to the dashboard `<img>`
  (`server.js`; mirrors the scrape `/view` proxy).
- **Client:** `openCampaignViewStream(id)` (`src/campaigns-client.js`).
- **Graceful until you ship it:** while `/api/campaign/:id/view` returns the SPA
  (`text/html`), the app detects that and shows *"Live browser view isn't
  available yet — the cloud engine doesn't stream campaign browsers."* The moment
  the engine returns a real `multipart/x-mixed-replace` stream, the button just
  works — **no app change needed.**

## Acceptance test
1. Start a cloud campaign; while it's sending, click **👁 Show** on its strip.
2. Expect a live view of the sending account's browser (connect requests / intros
   being typed and sent), streaming smoothly, and stopping when the modal closes.
