# Chrome Extension: "Connect" Button Fix + Browser-Type Toggle

**Captured:** 2026-04-30
**Status:** Not yet started — pick up in a future session

---

## The bug

When running the Ortus Chrome extension on the operator's **personal Google Chrome** (not GoLogin's Orbita browser), it errors out with:

> `no more button found`

This means the extension's selector logic is hardcoded for the GoLogin Orbita DOM structure, where the "Connect" button is reached via a "More" dropdown. On a regular Chrome (non-Orbita) profile, LinkedIn renders the "Connect" button **directly visible** on the profile, so the "More" button doesn't exist on that page — the script bails out instead of clicking the visible Connect.

## The intended logic (priority order)

1. **First:** look for a directly visible blue **"Connect"** button on the profile and click it.
2. **Fallback:** if no direct Connect button is found, look for the **"More"** button, click to open the dropdown, then click **"Connect"** inside the dropdown.
3. **Only if both fail:** report `no connect button found`.

The current behavior skips step 1 entirely and goes straight to step 2.

## Why the two-mode behavior is needed

LinkedIn renders different DOMs depending on the browser/profile:

- **Normal browsers (regular Chrome):** Connect button is usually directly visible on the profile header.
- **GoLogin Orbita / VM browsers:** Connect button is more often nested inside the "More" dropdown (likely due to different account types, fingerprints, or A/B test buckets).

A single hardcoded selector path won't reliably handle both. The script needs to **try the visible Connect first, then fall back to More → Connect**, regardless of which environment it runs in. The selector order needs to handle both cases gracefully.

## Proposed UX: a toggle inside the extension popup

Add a toggle to the extension's popup UI:

> **Browser type:** ( ) My normal Chrome  ( ) VM / GoLogin browser

- **My normal Chrome** → script uses selector logic optimized for the standard LinkedIn DOM (visible Connect button first).
- **VM / GoLogin browser** → script uses selector logic optimized for the Orbita DOM (More dropdown path first).
- Toggle persists in `chrome.storage.local` so the operator only sets it once per install.

**Even with the toggle**, both modes should still try both paths in order. The toggle only changes which path is tried *first* (an optimization). This keeps the script resilient if LinkedIn rolls out a DOM change to either bucket.

## What to investigate when picking this up

The extension code is **NOT in this repo** (`/Users/antoniovarlese/ortus-gologin-clone`). It lives in one of these candidate folders in `~/Downloads/`:

```
~/Downloads/ortus-connection-checker 6/
~/Downloads/ortus-connection-checker 7/
~/Downloads/ortus-connection-checker 8/
~/Downloads/ortus-connection-checker 9/
```

Most likely the highest-numbered one (`9`) is the latest. **First step in any future session:** confirm which one is actively loaded into Chrome (`chrome://extensions/`) and work from that copy. The "ortus-connection-checker" naming strongly matches this bug since "Connect" actions are exactly what the extension drives.

There's also `~/Downloads/ortus-salesnav-scraper-extension-main/` — that's a separate Sales Navigator scraper, not this issue. Don't confuse them.

## Files to look at first inside the extension folder

When you find the right folder:
- `manifest.json` — confirm it's the Connect-button extension
- `content.js` (or similar) — selector logic lives here, look for the string `more` or `Connect`
- `popup.html` + `popup.js` — where the new toggle UI would live
- Any `selectors.js` / `dom.js` helper file

Search for the exact error string to find the throw site:
```
grep -ri "no more button found" ~/Downloads/ortus-connection-checker*/
```

## Suggested implementation order

1. Find and confirm the active extension folder.
2. Read the current selector logic — understand exactly when it throws `no more button found`.
3. Add a "try direct Connect first" path before the existing More-dropdown path.
4. Add the toggle UI to the popup with `chrome.storage.local` persistence.
5. Wire the toggle to swap the order of the two paths (but both paths still run as fallback).
6. Test on operator's normal Chrome AND on a GoLogin Orbita session — both should now succeed.
7. Reload the extension in `chrome://extensions/` and confirm the bug is gone.

## Open questions for the future session

- Does LinkedIn ever render *both* a visible Connect button AND the More-dropdown Connect on the same profile? (If yes, clicking both would be a bug — need de-dupe.)
- Is there a third path — "Pending" / "Message" buttons — that the script should detect and short-circuit on, instead of treating as failure?
- Does the toggle need to be per-profile or is global fine?

## Out of scope

- Don't touch `src/linkedin/outreach.js` or `src/linkedin/actions.js` in the main repo — those are flagged off-limits in `CLAUDE.md` and unrelated to this extension fix.
- Don't migrate the extension into the main repo as part of this fix — that's a bigger architectural decision.
