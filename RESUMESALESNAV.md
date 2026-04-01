# Sales Nav Scraper — Resume Point

## What we're doing
Testing and fixing the Ortus Sales Nav Scraper Chrome extension. The extension batch-scrapes LinkedIn Sales Navigator search results to Google Sheets.

## Extension location
`/Users/antoniovarlese/Downloads/ortus-ccode-test-1.0/` — named "TEST CCode 1.0"

## Google Sheet for testing
https://docs.google.com/spreadsheets/d/1RfRDbghxk1AkpjgiYbxrnVfGhPisvKjJ_iVnksYNkho/edit?gid=0#gid=0

## What was fixed so far

### Problem: Partial fills — extension gets 0 profiles on many pages
Root cause found from service worker logs: `waitForResults` checked for `li.artdeco-list__item` elements and found 25 instantly (`waited=1ms`), BUT these were **empty placeholder shells** — LinkedIn renders empty `<li>` containers first, then lazily populates name/title/URL text. So the code thought results were ready but extracted 0 actual profiles.

### Fix applied (already in the code at ortus-ccode-test-1.0):
- **content.js**: `waitForResults` now checks for **populated** profile links (`a[href*="/sales/lead/"]` with `.textContent.length > 1`) and name spans (`[data-anonymize="person-name"]` with text), requiring at least 3 populated items before declaring ready
- **content.js**: `scrollAndExtractAll` pre-wait also polls for populated items, not just empty `<li>` shells
- **background.js**: Calls `waitForResults` before every `extractProfiles`, after re-inject retries, after full page reloads, after page navigation, and in the retry pass for skipped pages

### Previous fixes also in the code:
1. Smart page wait (MutationObserver DOM settling instead of fixed 30s)
2. Rate-limit/error page detection
3. Per-lead retry with backoff (campaign.js)
4. Race condition fix (in-progress URL locking)
5. Sender attribution fix
6. Modal detection increased to 8 attempts
7. Human-like log-normal delay distribution
8. Expanded Shadow DOM search (all roots, not just interop-outlet)

## What needs to happen next
1. **Reload the extension** in Chrome (chrome://extensions → TEST CCode 1.0 → reload button)
2. **Use computer-use to monitor** the service worker console in real-time while the scrape runs
3. Look for `waitForResults` logs — they should now show actual wait times (e.g. `waited=5000ms`) instead of `waited=1ms`
4. If pages still return 0 after the fix, analyze the new logs to see what's happening
5. Goal: ALL profiles scraped with zero partial fills

## Key files modified
- `/Users/antoniovarlese/Downloads/ortus-ccode-test-1.0/content.js` — v8 content script with DOM settling + populated-item checking
- `/Users/antoniovarlese/Downloads/ortus-ccode-test-1.0/background.js` — waitForResults calls throughout batch loop
- `/Users/antoniovarlese/Downloads/ortus-ccode-test-1.0/manifest.json` — named "TEST CCode 1.0" v1.0.0
- `/Users/antoniovarlese/Downloads/ortus-ccode-test-1.0/popup.html` — green header, "TEST CCode 1.0" branding

## Also modified (GoLogin automation, separate from extension):
- `src/linkedin/outreach.js` — smart wait, rate-limit detection
- `src/linkedin/actions.js` — 8 modal attempts, expanded shadow DOM
- `src/linkedin/helpers.js` — log-normal delays, expanded shadow DOM
- `src/campaign.js` — retry with backoff, race condition fix, attribution fix
