# Scraper engine — "who's ahead" named queue (engine-side spec)

**For:** the GKE scraper engine (`scraper.ortusclub.com`), owned outside this repo (Steven's scraper integration). The Ortus Outreach app already consumes this — see `_scrapeLadderHtml()` in `public/js/app.js`.

## Why
The app shows a queue ladder ("where am I in line") on the dashboard strip and the campaign panel's **Queue** tab. Today the engine's `GET /api/jobs?userId=<id>` returns only aggregate position data — `position`, `accountsAhead` (a count), `etaMs` — so the ladder can only show **anonymized** "Account ahead of you" slots. The operator wants the **real account name** of who's ahead.

## The change
For each **queued** job in the `/api/jobs` response, add an ordered `ahead` array describing the jobs in front of it, front-of-line first (index 0 = the account scraping right now):

```jsonc
{
  "id": "job-abc",
  "state": "queued",
  "position": 3,
  "accountsAhead": 2,        // keep — used as fallback
  "etaMs": 600000,           // keep — until THIS job starts
  "ahead": [
    { "label": "maria.lopez@ortus.solutions", "state": "running", "etaMs": 0 },
    { "label": "john.diaz@ortus.solutions",   "state": "queued",  "etaMs": 300000 }
  ]
}
```

Field notes:
- `label` — the account identity to display (GoLogin account email / account name). Required.
- `state` — `"running"` for the account scraping now, else `"queued"`. Optional; the app treats index 0 as running if absent.
- `etaMs` — optional per-slot estimate.
- Order: front-of-line first. `ahead.length` should equal `accountsAhead`.

The app renders names automatically when `ahead` is present, collapses the middle past 3 entries, and falls back to anonymized slots when it's absent — so this can ship without lockstep frontend changes.

## Privacy decision (confirm before building)
This surfaces, to every operator, the **account names** of other operators' queued/running scrape jobs. Within Ortus's shared account pool that's expected to be fine, but confirm:
- Show **account** label (e.g. `maria.lopez@…`) — recommended, it's the shared resource.
- vs. **operator/person** name — more identifying; only if wanted.

## App side (already done, this repo)
`public/js/app.js` `_scrapeLadderHtml()` reads `j.ahead[]` (`label`/`state`/`etaMs`) when present. No further app change needed once the engine sends it.
