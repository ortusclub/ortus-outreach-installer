# Capturing the Voyager + DOM fixtures (Phase 11.3)

Two fixtures must be captured from a **live, authenticated LinkedIn session**:

1. `tests/fixtures/voyager-conversations-page1.json` — the JSON response from LinkedIn's messaging API
2. `tests/fixtures/inbox-dom-page1.html` — the HTML of the inbox list (fallback)

These are authoritative — all test assertions and the Wave 1 implementation match against them.

---

## Prerequisites

- Chrome (regular, logged into LinkedIn with a Sales-Nav-enabled account)
- The LinkedIn account has at least 5–10 existing conversations (so we get a representative sample)

**Do NOT use your Electron Ortus instance for this.** Open a regular Chrome tab so you can redact names freely without affecting campaign state.

---

## Part 1 — Voyager JSON fixture (~2 minutes)

### Step 1: Open DevTools Network tab

1. In Chrome: navigate to `https://www.linkedin.com/` (stay on the feed for now)
2. `Cmd+Opt+I` (macOS) → **Network** tab
3. In the Network filter bar: type `messaging/conversations`
4. Check the **Preserve log** box (top-left area of Network tab)

### Step 2: Trigger the request

1. Click the 💬 Messaging icon in LinkedIn's top navigation (or directly visit `https://www.linkedin.com/messaging/`)
2. The inbox opens. You should see several XHR requests populate the Network panel — look for one like `messaging/conversations?q=search&count=20` or similar

### Step 3: Save the response

1. Click the request (the first one is fine — ignore V2 variants unless that's all you see)
2. Right pane → **Response** tab → click anywhere in the JSON → **Cmd+A** → **Cmd+C**
3. Paste into a new file: `tests/fixtures/voyager-conversations-page1.json`

### Step 4: Redact names

Open the file in your editor. Find-and-replace all real human names with placeholders:
- `"firstName": "Gurneet"` → `"firstName": "Redacted One"`
- `"lastName": "Jodhka"` → `"lastName": "Alpha"`
- Etc.

Keep the JSON **structurally intact** — only replace the string values. Don't touch URNs, IDs, timestamps.

---

## Part 2 — DOM fallback fixture (~1 minute)

### Step 1: In the same messaging page, open DevTools Elements

1. DevTools → **Elements** tab
2. `Cmd+F` inside Elements → search: `msg-conversation-listitem`
3. You should land on a `<li class="msg-conversation-listitem ...">` — scroll UP to find the containing `<ul>` element
4. Right-click the `<ul>` → **Copy** → **Copy outerHTML**

### Step 2: Save

1. Create: `tests/fixtures/inbox-dom-page1.html`
2. Paste the HTML

### Step 3: Redact names

Same treatment — find-and-replace display names with `Redacted ...`. Keep class names, IDs, data-attributes intact.

---

## Part 3 — Generate the degraded fixture (derived)

Once you have `voyager-conversations-page1.json`:

```bash
cp tests/fixtures/voyager-conversations-page1.json tests/fixtures/voyager-conversations-page1-degraded.json
```

Then open the `-degraded.json` copy and **remove every `events` array** (set to `[]` or delete the key entirely on each element). This tests that the implementation handles missing events gracefully.

---

## When you're done

Ping me and I'll finalize Wave 0: verify the fixtures load, run the 6 RED tests, and confirm they fail for the right reason (module missing, not fixture missing).

---

## When LinkedIn rotates the schema (future)

LinkedIn may change the Voyager response shape. When that happens:
1. Re-run Parts 1–3 to capture fresh fixtures
2. Update the RED tests if the schema introduces new fields that the implementation must handle
3. Bump the phase's validation number

The fixtures are lockfiles — keep them in git so git history tells us when schemas changed.
