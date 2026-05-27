# Voyager Intro-Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failure-prone DOM typeahead in the auto-intro 3-way DM with a direct Voyager `POST /messaging/createMessage`, preserving the existing typeahead path byte-for-byte as fallback.

**Architecture:** Three new pure-helper functions (URN resolver, payload builder, response parser) + one new orchestrator (`sendIntroViaVoyager`) called from `auto-intro.js` BEFORE the existing typeahead loop. If Voyager succeeds: skip the typeahead block. If Voyager fails: fall through to the unchanged typeahead block. Title is best-effort — Voyager retries once without title if the with-title call fails.

**Tech Stack:** Node ≥22, ESM, `node:test`, `node:assert/strict`, Puppeteer 22.x for `page.evaluate(() => fetch(...))`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-18-voyager-intro-send-design.md` — all API field names, header values, endpoint URLs, and payload shapes in this plan are grounded in the DevTools recon captured there on 2026-05-18 09:49 UTC.

**Constraints (operator-stated):**
- `src/linkedin/outreach.js` and `src/linkedin/actions.js` — **zero diff**. Off-limits per CLAUDE.md.
- Existing typeahead retry loop in `auto-intro.js:267-295` — **kept verbatim** as fallback. New code wraps around it; nothing inside is deleted.
- Sheet column headers and status string values (`Introduction Made`, `Failed`, `Skipped — …`) — **unchanged**.
- No guesses — every payload field name comes from the captured recon.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/linkedin/helpers.js` | **Modify** — append two new exported functions at end of file | `resolveProfileUrn(page, publicId)` and `getSenderUrn(page)` — pure Voyager-fetch helpers, no new patterns |
| `src/linkedin/intro-voyager.js` | **Create** (new file) | All Voyager intro logic: `buildCreateMessagePayload`, `parseCreateMessageResponse`, `sendIntroViaVoyager` |
| `src/linkedin/auto-intro.js` | **Modify** — insert new block at line 267, KEEP existing while loop at 271-295 intact | Try-Voyager-first orchestration before falling through to existing typeahead loop |
| `tests/intro-voyager-payload.test.js` | **Create** (new file) | Unit tests for `buildCreateMessagePayload` |
| `tests/intro-voyager-parse-response.test.js` | **Create** (new file) | Unit tests for `parseCreateMessageResponse` |
| `tests/intro-voyager-resolve-urn.test.js` | **Create** (new file) | Unit tests for `resolveProfileUrn` URN extraction logic |
| `tests/fixtures/voyager-create-message-success-200.json` | **Create** (new fixture) | The captured 200 response from the recon, verbatim |
| `tests/fixtures/voyager-identity-profile-success.json` | **Create** (new fixture) | Sample `/voyager/api/identity/profiles/<publicId>` response with profile URN |

**Files explicitly NOT touched:** `src/linkedin/outreach.js`, `src/linkedin/actions.js`, `src/campaign.js`, the wizard, the sheet schema, `google-apps-script.js`, the Apps Script bridges.

---

## Task 1: Capture the recon response as a test fixture

**Files:**
- Create: `tests/fixtures/voyager-create-message-success-200.json`
- Create: `tests/fixtures/voyager-identity-profile-success.json`

- [ ] **Step 1: Write the success-response fixture from the recon capture**

File: `tests/fixtures/voyager-create-message-success-200.json`

```json
{
  "value": {
    "renderContentUnions": [],
    "entityUrn": "urn:li:msg_message:(urn:li:fsd_profile:ACoAABkKUycBZd5cdhq31vO7Rm9K5fCc2Nu6UgA,2-MTc3OTA5MDU4MDk5M2I4OTA0OS0xMDAmOTkyY2RjYjQtOTcwYS00MmZjLWI5ZDYtM2FlZDM4M2U3ZDNkXzEwMA==)",
    "backendConversationUrn": "urn:li:messagingThread:2-OTkyY2RjYjQtOTcwYS00MmZjLWI5ZDYtM2FlZDM4M2U3ZDNkXzEwMA==",
    "senderUrn": "urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAABkKUycBZd5cdhq31vO7Rm9K5fCc2Nu6UgA",
    "originToken": "68a62c18-7fda-4398-9a6d-ca8775f4baef",
    "body": {
      "attributes": [],
      "text": "recon test body do not reply"
    },
    "backendUrn": "urn:li:messagingMessage:2-MTc3OTA5MDU4MDk5M2I4OTA0OS0xMDAmOTkyY2RjYjQtOTcwYS00MmZjLWI5ZDYtM2FlZDM4M2U3ZDNkXzEwMA==",
    "conversationUrn": "urn:li:msg_conversation:(urn:li:fsd_profile:ACoAABkKUycBZd5cdhq31vO7Rm9K5fCc2Nu6UgA,2-OTkyY2RjYjQtOTcwYS00MmZjLWI5ZDYtM2FlZDM4M2U3ZDNkXzEwMA==)",
    "deliveredAt": 1779090581245
  }
}
```

- [ ] **Step 2: Write the identity-profile fixture**

File: `tests/fixtures/voyager-identity-profile-success.json`

This mirrors the shape that `/voyager/api/identity/profiles/<publicId>` returns, with `entityUrn` populated. Real shape is verified by reading existing extraction logic in `src/linkedin/helpers.js:584-607` (which handles `data.entityUrn`, `data.data.entityUrn`, `data.profile.entityUrn`, `data.miniProfile.entityUrn`, plus `data.included[].entityUrn`).

```json
{
  "entityUrn": "urn:li:fsd_profile:ACoAACa0cGUBIFz763pB0KKaLKszka94Bw35fyo",
  "publicIdentifier": "samueladcock",
  "firstName": "Samuel",
  "lastName": "Adcock",
  "included": []
}
```

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/voyager-create-message-success-200.json tests/fixtures/voyager-identity-profile-success.json
git commit -m "test(voyager-intro): capture recon fixtures for createMessage + identity-profile"
```

---

## Task 2: URN resolver — `resolveProfileUrn` extraction logic

**Files:**
- Create: `tests/intro-voyager-resolve-urn.test.js`
- Modify: `src/linkedin/helpers.js` (append new export at end of file)

- [ ] **Step 1: Write the failing tests**

File: `tests/intro-voyager-resolve-urn.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractProfileUrnFromVoyagerResponse } from '../src/linkedin/helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(
  join(__dirname, 'fixtures/voyager-identity-profile-success.json'),
  'utf8'
));

test('extractProfileUrnFromVoyagerResponse: returns urn from top-level entityUrn', () => {
  const urn = extractProfileUrnFromVoyagerResponse(fixture);
  assert.equal(urn, 'urn:li:fsd_profile:ACoAACa0cGUBIFz763pB0KKaLKszka94Bw35fyo');
});

test('extractProfileUrnFromVoyagerResponse: returns urn from data.entityUrn', () => {
  const data = { data: { entityUrn: 'urn:li:fsd_profile:ACoAAExample123' } };
  assert.equal(extractProfileUrnFromVoyagerResponse(data), 'urn:li:fsd_profile:ACoAAExample123');
});

test('extractProfileUrnFromVoyagerResponse: returns urn from included[] when top-level is collection envelope', () => {
  const data = {
    entityUrn: 'urn:li:collectionResponse:foo',
    included: [
      { entityUrn: 'urn:li:somethingElse:noise' },
      { entityUrn: 'urn:li:fsd_profile:ACoAATargetXyz', publicIdentifier: 'target' },
    ],
  };
  assert.equal(extractProfileUrnFromVoyagerResponse(data), 'urn:li:fsd_profile:ACoAATargetXyz');
});

test('extractProfileUrnFromVoyagerResponse: returns empty string when no profile urn anywhere', () => {
  assert.equal(extractProfileUrnFromVoyagerResponse({}), '');
  assert.equal(extractProfileUrnFromVoyagerResponse({ entityUrn: 'urn:li:other:foo' }), '');
  assert.equal(extractProfileUrnFromVoyagerResponse(null), '');
});

test('extractProfileUrnFromVoyagerResponse: accepts fs_miniProfile and fs_profile prefixes', () => {
  assert.equal(
    extractProfileUrnFromVoyagerResponse({ entityUrn: 'urn:li:fs_miniProfile:ACoAAMini' }),
    'urn:li:fs_miniProfile:ACoAAMini'
  );
  assert.equal(
    extractProfileUrnFromVoyagerResponse({ entityUrn: 'urn:li:fs_profile:ACoAAOld' }),
    'urn:li:fs_profile:ACoAAOld'
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/intro-voyager-resolve-urn.test.js`
Expected: 5 failures, error mentions `extractProfileUrnFromVoyagerResponse` not exported from helpers.js.

- [ ] **Step 3: Add the extraction function to helpers.js**

Append at the end of `src/linkedin/helpers.js` (after the last existing export, before EOF):

```javascript

/**
 * Extract a profile URN from a Voyager /identity/profiles/* response payload.
 *
 * Voyager returns the profile URN in several shapes depending on the endpoint
 * variant and decoration version. This helper walks the known locations in
 * priority order and returns the first `urn:li:fsd_profile:` / `fs_miniProfile`
 * / `fs_profile` URN it finds. Returns '' if none.
 *
 * Pure function — no page/network. Extracted as a separate export so the URN
 * resolver in intro-voyager.js and the existing captureProfileMeta both
 * exercise the same logic (currently captureProfileMeta inlines it at L584).
 */
export function extractProfileUrnFromVoyagerResponse(data) {
  if (!data || typeof data !== 'object') return '';
  const isProfileUrn = (s) =>
    typeof s === 'string' &&
    (s.indexOf('urn:li:fsd_profile:') === 0 ||
     s.indexOf('urn:li:fs_miniProfile:') === 0 ||
     s.indexOf('urn:li:fs_profile:') === 0);

  const candidates = [
    data.entityUrn,
    data.data?.entityUrn,
    data.profile?.entityUrn,
    data.miniProfile?.entityUrn,
  ];
  for (const c of candidates) {
    if (isProfileUrn(c)) return c;
  }
  if (Array.isArray(data.included)) {
    for (const item of data.included) {
      if (item && isProfileUrn(item.entityUrn)) return item.entityUrn;
    }
  }
  if (Array.isArray(data.data?.['*elements'])) {
    for (const ref of data.data['*elements']) {
      if (isProfileUrn(ref)) return ref;
    }
  }
  return '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/intro-voyager-resolve-urn.test.js`
Expected: 5 tests passing.

- [ ] **Step 5: Verify existing tests still pass**

Run: `npm test`
Expected: All previously-passing tests still pass. Look for the summary line — should be the same count as before plus 5 new.

- [ ] **Step 6: Commit**

```bash
git add tests/intro-voyager-resolve-urn.test.js src/linkedin/helpers.js
git commit -m "feat(helpers): export extractProfileUrnFromVoyagerResponse (pure helper)"
```

---

## Task 3: URN resolver — `resolveProfileUrn(page, publicId)` page-side fetch

**Files:**
- Modify: `src/linkedin/helpers.js` (append second function)

This task adds the page-side wrapper that does the actual `fetch()` inside `page.evaluate()`. We can't unit-test the fetch itself (it requires a real LinkedIn page context), but Task 2 already covered the response-extraction logic. This task is a thin shim — minimal logic, exhaustively tested via the manual end-to-end in Phase 4.

- [ ] **Step 1: Append `resolveProfileUrn` to helpers.js**

Append immediately after the `extractProfileUrnFromVoyagerResponse` function from Task 2:

```javascript

/**
 * Resolve a LinkedIn public-id (`samueladcock`, `cindy-pambid-1b7113338`, etc.)
 * to its profile URN (`urn:li:fsd_profile:ACoAA…`) WITHOUT navigating to the
 * profile page. Uses the same Voyager `/identity/profiles/<publicId>` endpoint
 * already proven by captureProfileMeta (helpers.js:560).
 *
 * Returns '' if the lookup fails for any reason (network error, 404, 403,
 * non-JSON response, no URN in response). Callers fall back to typeahead.
 *
 * @param {puppeteer.Page} page  - active LinkedIn page (any URL works — needs
 *                                  only the JSESSIONID cookie for CSRF)
 * @param {string} publicId      - the slug after /in/ in a LinkedIn URL
 * @returns {Promise<string>}    - profile URN or '' on any failure
 */
export async function resolveProfileUrn(page, publicId) {
  if (!publicId || typeof publicId !== 'string') return '';
  try {
    const result = await page.evaluate(async (pid) => {
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        if (!csrf) return { ok: false, reason: 'no-csrf' };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const url = `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(pid)}`;
        const resp = await fetch(url, {
          headers: {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
          },
          credentials: 'include',
        });
        if (!resp.ok) return { ok: false, reason: `http-${resp.status}` };
        const data = await resp.json();
        return { ok: true, data };
      } catch (err) {
        return { ok: false, reason: 'fetch-threw', message: String(err && err.message || err) };
      }
    }, publicId);

    if (!result || !result.ok) return '';
    return extractProfileUrnFromVoyagerResponse(result.data);
  } catch (err) {
    return '';
  }
}
```

- [ ] **Step 2: Verify the file still parses (syntax check)**

Run: `node --check src/linkedin/helpers.js`
Expected: no output (clean parse). If it errors, fix before continuing.

- [ ] **Step 3: Run the full test suite to verify no regressions**

Run: `npm test`
Expected: same count as Task 2's pass count. No new failures.

- [ ] **Step 4: Commit**

```bash
git add src/linkedin/helpers.js
git commit -m "feat(helpers): resolveProfileUrn(page, publicId) for non-navigating URN lookup"
```

---

## Task 4: Sender URN helper — `getSenderUrn(page)`

**Files:**
- Modify: `src/linkedin/helpers.js` (append third function)

The sender's URN is needed for the `mailboxUrn` field of every createMessage call. The Voyager `/me` endpoint returns it. We cache it per-page-session via a WeakMap so we only fetch once per profile.

- [ ] **Step 1: Append `getSenderUrn` to helpers.js**

Append immediately after `resolveProfileUrn` from Task 3:

```javascript

// Per-page-session cache for the sender's URN. WeakMap so the entry is GC'd
// when the page is closed. Cleared implicitly per profile relaunch.
const _senderUrnCache = new WeakMap();

/**
 * Get the URN of the currently-logged-in LinkedIn account on this page.
 * Calls /voyager/api/me which returns the viewer's profile entity. Cached
 * per-page so the second+ intro in the same auto-intro loop is free.
 *
 * Returns '' on any failure. Callers fall back to typeahead.
 *
 * @param {puppeteer.Page} page - active LinkedIn page
 * @returns {Promise<string>}   - sender's profile URN or ''
 */
export async function getSenderUrn(page) {
  const cached = _senderUrnCache.get(page);
  if (cached) return cached;

  try {
    const result = await page.evaluate(async () => {
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        if (!csrf) return { ok: false };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const resp = await fetch('https://www.linkedin.com/voyager/api/me', {
          headers: {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
          },
          credentials: 'include',
        });
        if (!resp.ok) return { ok: false };
        return { ok: true, data: await resp.json() };
      } catch {
        return { ok: false };
      }
    });

    if (!result || !result.ok) return '';
    const urn = extractProfileUrnFromVoyagerResponse(result.data);
    if (urn) _senderUrnCache.set(page, urn);
    return urn;
  } catch {
    return '';
  }
}
```

- [ ] **Step 2: Syntax-check**

Run: `node --check src/linkedin/helpers.js`
Expected: clean parse, no output.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: same count, no new failures.

- [ ] **Step 4: Commit**

```bash
git add src/linkedin/helpers.js
git commit -m "feat(helpers): getSenderUrn(page) with per-page WeakMap cache"
```

---

## Task 5: Payload builder + tests

**Files:**
- Create: `tests/intro-voyager-payload.test.js`
- Create: `src/linkedin/intro-voyager.js`

- [ ] **Step 1: Write the failing tests**

File: `tests/intro-voyager-payload.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreateMessagePayload } from '../src/linkedin/intro-voyager.js';

test('buildCreateMessagePayload: produces all required top-level fields with title', () => {
  const payload = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hello — meet Sam.',
    title: 'Intro: lead <> Sam',
  });
  assert.equal(payload.mailboxUrn, 'urn:li:fsd_profile:ACoAASender');
  assert.deepEqual(payload.hostRecipientUrns, [
    'urn:li:fsd_profile:ACoAALead',
    'urn:li:fsd_profile:ACoAAPrimary',
  ]);
  assert.equal(payload.message.body.text, 'Hello — meet Sam.');
  assert.deepEqual(payload.message.body.attributes, []);
  assert.deepEqual(payload.message.renderContentUnions, []);
  assert.equal(payload.conversationTitle, 'Intro: lead <> Sam');
  assert.equal(payload.dedupeByClientGeneratedToken, false);
  assert.equal(typeof payload.trackingId, 'string');
  assert.equal(payload.trackingId.length, 16);
  assert.equal(typeof payload.message.originToken, 'string');
  // originToken is a UUID v4: 8-4-4-4-12 hex
  assert.match(payload.message.originToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('buildCreateMessagePayload: omits conversationTitle when title is empty', () => {
  const payload = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.',
    title: '',
  });
  assert.equal('conversationTitle' in payload, false);
});

test('buildCreateMessagePayload: omits conversationTitle when title is whitespace-only', () => {
  const payload = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.',
    title: '   ',
  });
  assert.equal('conversationTitle' in payload, false);
});

test('buildCreateMessagePayload: omits conversationTitle when title is undefined', () => {
  const payload = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.',
  });
  assert.equal('conversationTitle' in payload, false);
});

test('buildCreateMessagePayload: each call gets a fresh trackingId and originToken', () => {
  const a = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.', title: 'T',
  });
  const b = buildCreateMessagePayload({
    senderUrn: 'urn:li:fsd_profile:ACoAASender',
    recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
    body: 'Hi.', title: 'T',
  });
  assert.notEqual(a.trackingId, b.trackingId);
  assert.notEqual(a.message.originToken, b.message.originToken);
});

test('buildCreateMessagePayload: throws on missing senderUrn', () => {
  assert.throws(
    () => buildCreateMessagePayload({
      senderUrn: '',
      recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
      body: 'Hi.',
    }),
    /senderUrn required/i,
  );
});

test('buildCreateMessagePayload: throws on empty recipientUrns', () => {
  assert.throws(
    () => buildCreateMessagePayload({
      senderUrn: 'urn:li:fsd_profile:ACoAASender',
      recipientUrns: [],
      body: 'Hi.',
    }),
    /recipientUrns required/i,
  );
});

test('buildCreateMessagePayload: throws on missing body', () => {
  assert.throws(
    () => buildCreateMessagePayload({
      senderUrn: 'urn:li:fsd_profile:ACoAASender',
      recipientUrns: ['urn:li:fsd_profile:ACoAALead', 'urn:li:fsd_profile:ACoAAPrimary'],
      body: '',
    }),
    /body required/i,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/intro-voyager-payload.test.js`
Expected: 8 failures — error "Cannot find module" for `intro-voyager.js`.

- [ ] **Step 3: Create `intro-voyager.js` with the payload builder**

File: `src/linkedin/intro-voyager.js`

```javascript
/**
 * Voyager intro-send module — 3-way introduction DM via direct API.
 *
 * Spec: docs/superpowers/specs/2026-05-18-voyager-intro-send-design.md
 * Endpoint: POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
 *
 * Used by auto-intro.js as the preferred path. If this rejects (4xx, network
 * error), the caller falls through to the existing DOM typeahead at
 * actions.js:sendIntroMessage.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { resolveProfileUrn, getSenderUrn } from './helpers.js';

const ENDPOINT = 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage';

/**
 * Build the JSON payload for the createMessage POST.
 *
 * Shape grounded in the 2026-05-18 DevTools recon captured at
 * docs/superpowers/specs/2026-05-18-voyager-intro-send-design.md.
 *
 * @param {object} args
 * @param {string} args.senderUrn        - urn:li:fsd_profile:ACoAA…
 * @param {string[]} args.recipientUrns  - [leadUrn, primaryUrn] in that order
 * @param {string} args.body             - the message body text
 * @param {string} [args.title]          - optional conversation title; omitted from payload if empty/whitespace
 * @returns {object} payload object (caller JSON.stringify's it for the POST)
 */
export function buildCreateMessagePayload({ senderUrn, recipientUrns, body, title } = {}) {
  if (!senderUrn || typeof senderUrn !== 'string') {
    throw new Error('buildCreateMessagePayload: senderUrn required');
  }
  if (!Array.isArray(recipientUrns) || recipientUrns.length === 0) {
    throw new Error('buildCreateMessagePayload: recipientUrns required (non-empty array)');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('buildCreateMessagePayload: body required');
  }

  const payload = {
    message: {
      body: { attributes: [], text: body },
      originToken: randomUUID(),
      renderContentUnions: [],
    },
    mailboxUrn: senderUrn,
    hostRecipientUrns: recipientUrns.slice(),
    dedupeByClientGeneratedToken: false,
    // 16-char alphanumeric tracking id (LinkedIn's UI uses 16 random bytes;
    // alphanumeric is accepted equivalently by the OSS linkedin-api lib
    // and survives JSON encoding cleanly).
    trackingId: randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16),
  };
  const t = (title || '').trim();
  if (t) payload.conversationTitle = t;
  return payload;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/intro-voyager-payload.test.js`
Expected: 8 tests passing.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add tests/intro-voyager-payload.test.js src/linkedin/intro-voyager.js
git commit -m "feat(intro-voyager): buildCreateMessagePayload with recon-grounded shape"
```

---

## Task 6: Response parser + tests

**Files:**
- Create: `tests/intro-voyager-parse-response.test.js`
- Modify: `src/linkedin/intro-voyager.js` (append `parseCreateMessageResponse`)

- [ ] **Step 1: Write the failing tests**

File: `tests/intro-voyager-parse-response.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCreateMessageResponse } from '../src/linkedin/intro-voyager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const successFixture = JSON.parse(readFileSync(
  join(__dirname, 'fixtures/voyager-create-message-success-200.json'),
  'utf8'
));

test('parseCreateMessageResponse: extracts conversationUrn from 200 response', () => {
  const result = parseCreateMessageResponse({ status: 200, body: successFixture });
  assert.equal(result.ok, true);
  assert.equal(
    result.conversationUrn,
    'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAABkKUycBZd5cdhq31vO7Rm9K5fCc2Nu6UgA,2-OTkyY2RjYjQtOTcwYS00MmZjLWI5ZDYtM2FlZDM4M2U3ZDNkXzEwMA==)'
  );
  assert.equal(
    result.backendConversationUrn,
    'urn:li:messagingThread:2-OTkyY2RjYjQtOTcwYS00MmZjLWI5ZDYtM2FlZDM4M2U3ZDNkXzEwMA=='
  );
  assert.equal(result.deliveredAt, 1779090581245);
});

test('parseCreateMessageResponse: 4xx returns ok=false with status + errorBody', () => {
  const result = parseCreateMessageResponse({
    status: 403,
    body: { errorDetails: { code: 'FORBIDDEN' }, message: 'not 1st-degree' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.errorBody.message, 'not 1st-degree');
});

test('parseCreateMessageResponse: 200 with empty body returns ok=false', () => {
  const result = parseCreateMessageResponse({ status: 200, body: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing conversationUrn/i);
});

test('parseCreateMessageResponse: 5xx returns ok=false', () => {
  const result = parseCreateMessageResponse({ status: 503, body: 'gateway' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/intro-voyager-parse-response.test.js`
Expected: 4 failures — `parseCreateMessageResponse` not exported.

- [ ] **Step 3: Append `parseCreateMessageResponse` to intro-voyager.js**

Append at the end of `src/linkedin/intro-voyager.js`:

```javascript

/**
 * Parse the response from a createMessage POST.
 *
 * Success shape (status 200): { value: { conversationUrn, backendConversationUrn, deliveredAt, ... } }
 * Error shape (status 4xx/5xx): arbitrary JSON or plain text; we just pass it through.
 *
 * @param {object} args
 * @param {number} args.status   - HTTP status code
 * @param {object|string} args.body - parsed JSON body (or raw string if non-JSON)
 * @returns {object} either:
 *   { ok: true,  conversationUrn, backendConversationUrn, deliveredAt }
 *   { ok: false, status, errorBody, reason? }
 */
export function parseCreateMessageResponse({ status, body } = {}) {
  if (status !== 200) {
    return { ok: false, status, errorBody: body };
  }
  const value = body && typeof body === 'object' ? body.value : null;
  if (!value || !value.conversationUrn) {
    return { ok: false, status, errorBody: body, reason: 'missing conversationUrn in response' };
  }
  return {
    ok: true,
    conversationUrn: value.conversationUrn,
    backendConversationUrn: value.backendConversationUrn || '',
    deliveredAt: value.deliveredAt || 0,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/intro-voyager-parse-response.test.js`
Expected: 4 tests passing.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add tests/intro-voyager-parse-response.test.js src/linkedin/intro-voyager.js
git commit -m "feat(intro-voyager): parseCreateMessageResponse — 200/4xx/5xx handling"
```

---

## Task 7: Voyager POST orchestrator — `sendIntroViaVoyager`

**Files:**
- Modify: `src/linkedin/intro-voyager.js` (append the page-side fetch wrapper)

This task adds the function that resolves URNs, builds the payload, posts it inside `page.evaluate(() => fetch(...))`, and returns the parsed result. It cannot be unit-tested directly (requires a real LinkedIn page); it's exercised by the manual end-to-end in Phase 4.

- [ ] **Step 1: Append `sendIntroViaVoyager` to intro-voyager.js**

```javascript

/**
 * Resolve URNs, build payload, POST, parse response. Returns a result object
 * the caller can act on. NEVER throws — all failure modes are returned as
 * { ok: false, ... } so the caller can decide to fall back.
 *
 * @param {object} args
 * @param {puppeteer.Page} args.page     - active LinkedIn page (sender's session)
 * @param {string} args.leadUrl          - sheet URL of the lead (e.g. linkedin.com/in/cindy-pambid-1b7113338/)
 * @param {string} args.primaryUrl       - operator-configured primary person URL
 * @param {string} args.body             - personalized message body
 * @param {string} [args.title]          - personalized conversation title (best-effort)
 * @returns {Promise<object>} parseCreateMessageResponse output, with an extra
 *   `phase` field telling the caller WHICH step failed if ok=false:
 *     'resolve-lead-urn' | 'resolve-primary-urn' | 'resolve-sender-urn' |
 *     'post-network-error' | 'post-non-200' | 'parse'
 */
export async function sendIntroViaVoyager({ page, leadUrl, primaryUrl, body, title } = {}) {
  // Parse public ids from URLs (sheet-stored as full linkedin.com/in/<id>/ URLs).
  const leadPublicId = _extractPublicId(leadUrl);
  const primaryPublicId = _extractPublicId(primaryUrl);
  if (!leadPublicId) return { ok: false, phase: 'resolve-lead-urn', reason: `bad leadUrl: ${leadUrl}` };
  if (!primaryPublicId) return { ok: false, phase: 'resolve-primary-urn', reason: `bad primaryUrl: ${primaryUrl}` };

  // Resolve all three URNs (in parallel for speed).
  const [leadUrn, primaryUrn, senderUrn] = await Promise.all([
    resolveProfileUrn(page, leadPublicId),
    resolveProfileUrn(page, primaryPublicId),
    getSenderUrn(page),
  ]);
  if (!leadUrn)    return { ok: false, phase: 'resolve-lead-urn',    reason: `URN lookup empty for ${leadPublicId}` };
  if (!primaryUrn) return { ok: false, phase: 'resolve-primary-urn', reason: `URN lookup empty for ${primaryPublicId}` };
  if (!senderUrn)  return { ok: false, phase: 'resolve-sender-urn',  reason: 'URN lookup empty for self' };

  const doPost = async (payload) => {
    return await page.evaluate(async (endpoint, payloadJson) => {
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        if (!csrf) return { network: 'no-csrf' };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const resp = await fetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'accept': 'application/json',
            'content-type': 'text/plain;charset=UTF-8',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
          },
          body: payloadJson,
        });
        const status = resp.status;
        const text = await resp.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        return { status, body: parsed };
      } catch (err) {
        return { network: String(err && err.message || err) };
      }
    }, ENDPOINT, JSON.stringify(payload));
  };

  // Attempt 1: with title (if present)
  const payload1 = buildCreateMessagePayload({
    senderUrn, recipientUrns: [leadUrn, primaryUrn], body, title,
  });
  const resp1 = await doPost(payload1);
  if (resp1.network) {
    return { ok: false, phase: 'post-network-error', reason: resp1.network };
  }
  const parsed1 = parseCreateMessageResponse(resp1);
  if (parsed1.ok) return { ...parsed1, phase: 'ok', titleSent: !!payload1.conversationTitle };

  // Attempt 2: retry without title, but only if title WAS set in attempt 1
  // (otherwise there's nothing to vary — fail immediately)
  if (payload1.conversationTitle) {
    const payload2 = buildCreateMessagePayload({
      senderUrn, recipientUrns: [leadUrn, primaryUrn], body, title: '',
    });
    const resp2 = await doPost(payload2);
    if (resp2.network) {
      return { ok: false, phase: 'post-network-error', reason: resp2.network, firstAttempt: parsed1 };
    }
    const parsed2 = parseCreateMessageResponse(resp2);
    if (parsed2.ok) return { ...parsed2, phase: 'ok', titleSent: false, retriedWithoutTitle: true };
    return { ok: false, phase: 'post-non-200', firstAttempt: parsed1, secondAttempt: parsed2 };
  }

  return { ok: false, phase: 'post-non-200', firstAttempt: parsed1 };
}

function _extractPublicId(url) {
  if (!url || typeof url !== 'string') return '';
  const m = url.match(/\/in\/([^/?#]+)/);
  return m ? m[1] : '';
}
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check src/linkedin/intro-voyager.js`
Expected: clean parse.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: no regressions, same count.

- [ ] **Step 4: Commit**

```bash
git add src/linkedin/intro-voyager.js
git commit -m "feat(intro-voyager): sendIntroViaVoyager with title-retry chain"
```

---

## Task 8: Wire into auto-intro.js — Voyager-first with preserved typeahead fallback

**Files:**
- Modify: `src/linkedin/auto-intro.js` (insert new block BEFORE line 267's `let ok = false;`)

**Critical constraint:** the existing typeahead while loop at lines 267-295 must remain **byte-for-byte unchanged**. The new code is INSERTED before it, and if Voyager succeeds, sets `ok = true` so the existing loop is effectively skipped (the loop only runs if `ok` is still false when entered).

Wait — re-reading auto-intro.js:267 — `let ok = false;` is the declaration. Then `let alreadyMade = false; let errMsg = '';` etc. The while loop runs unconditionally. To preserve the loop while skipping it when Voyager succeeds, we add a guard inside the while: `if (ok) break;` at the top of the loop body — but that would modify the loop.

Better: insert the Voyager attempt BEFORE the `let ok = false;` declaration, capture its result in a separate variable, and gate the existing loop with a single guard. Cleanest non-destructive form below.

- [ ] **Step 1: Add the import at the top of auto-intro.js**

In `src/linkedin/auto-intro.js`, line 21 currently reads:

```javascript
import { sendIntroMessage } from './actions.js';
```

Add a new import line directly below it:

```javascript
import { sendIntroMessage } from './actions.js';
import { sendIntroViaVoyager } from './intro-voyager.js';
```

- [ ] **Step 2: Insert the Voyager-first block BEFORE line 267**

In `src/linkedin/auto-intro.js`, find this existing block starting at line 266 (the line with `const title = personalizeTemplate(tpl.introTitle, introData);`):

```javascript
    const body  = personalizeTemplate(tpl.followUpMessage, introData);
    const title = personalizeTemplate(tpl.introTitle, introData);

    let ok = false;
    let alreadyMade = false;
    let errMsg = '';
    let attempt = 0;
    while (attempt < 2) {
```

Insert the following block BETWEEN the `const title` line and the `let ok = false;` line (do not modify either of those lines or any line after — only insert):

```javascript
    const body  = personalizeTemplate(tpl.followUpMessage, introData);
    const title = personalizeTemplate(tpl.introTitle, introData);

    // v2.51.0 — Voyager-first intro send. When primaryUrl is set, try the
    // direct API path (POST /voyager/api/.../createMessage). If it succeeds,
    // skip the DOM typeahead entirely. If it fails (4xx, network error,
    // URN-resolve fail), fall through to the existing typeahead loop below
    // BYTE-FOR-BYTE UNCHANGED. Spec: 2026-05-18-voyager-intro-send-design.md
    let _voyagerOk = false;
    let _voyagerConversationUrn = '';
    if (primaryUrl) {
      try {
        const vResult = await sendIntroViaVoyager({ page, leadUrl: url, primaryUrl, body, title });
        if (vResult.ok) {
          _voyagerOk = true;
          _voyagerConversationUrn = vResult.conversationUrn;
          if (vResult.retriedWithoutTitle) {
            log(`  🤝 [${profileName}] ${url}: Voyager ok (retried without title), convo=${vResult.conversationUrn}`);
          } else {
            log(`  🤝 [${profileName}] ${url}: Voyager ok, convo=${vResult.conversationUrn}`);
          }
        } else {
          const detail = vResult.phase || 'unknown';
          const reason = vResult.reason || (vResult.firstAttempt && vResult.firstAttempt.status) || '';
          log(`  ↪ [${profileName}] ${url}: Voyager rejected (phase=${detail}, reason=${reason}) — falling back to typeahead`);
        }
      } catch (voyErr) {
        log(`  ↪ [${profileName}] ${url}: Voyager threw (${voyErr.message || voyErr}) — falling back to typeahead`);
      }
    }

    let ok = _voyagerOk;
    let alreadyMade = false;
    let errMsg = '';
    let attempt = 0;
    while (!ok && attempt < 2) {
```

Two precise changes only:
1. **Insertion** of the entire Voyager block (lines beginning with `// v2.51.0` through the `}` closing the outer `if (primaryUrl)`).
2. **Two-character change** to the existing `let ok = false;` → `let ok = _voyagerOk;`
3. **One-condition change** to `while (attempt < 2)` → `while (!ok && attempt < 2)`

Every other line in the existing loop (lines 271-295 in the original file) stays exactly as it was.

- [ ] **Step 3: Verify the file still parses**

Run: `node --check src/linkedin/auto-intro.js`
Expected: clean parse.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: no regressions. All existing tests still pass.

- [ ] **Step 5: Verify the diff is what we expect**

Run: `git diff src/linkedin/auto-intro.js`
Expected diff contains:
- One new import line (line ~22)
- One inserted block (the Voyager-first block)
- Two micro-changes: `let ok = false;` → `let ok = _voyagerOk;` and `while (attempt < 2)` → `while (!ok && attempt < 2)`

If any line in the existing while-loop body has changed (lines 271-295 of the original) — STOP and revert. The constraint is byte-for-byte preservation of the fallback path.

- [ ] **Step 6: Commit**

```bash
git add src/linkedin/auto-intro.js
git commit -m "feat(auto-intro): try Voyager createMessage first, fall back to typeahead on failure"
```

---

## Task 9: Auto-relaunch dev:app for manual verification

Per the operator rule in CLAUDE.md: after every commit that touches runtime code, kill+restart dev:app.

- [ ] **Step 1: Kill any running dev:app**

Run:
```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
```

Expected: no output (or "no such process"). Both fine.

- [ ] **Step 2: Relaunch dev:app in background**

Run:
```bash
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Expected: shell returns immediately. The app comes up within ~3 seconds.

- [ ] **Step 3: Verify the server is up**

Run:
```bash
sleep 3 && grep -E "Server running|listening on" /tmp/dev-app.log | head -3
```

Expected: a line like `Server running at http://localhost:<port>`.

---

## Task 10: Manual end-to-end verification (operator-driven)

This task requires the operator to run a real CC+IC campaign with 1-2 leads. It cannot be automated. The acceptance criteria from the spec section "Acceptance criteria" are validated here.

- [ ] **Step 1: Operator picks 1-2 leads from a working campaign sheet**

Recommended: 1 lead that's a 1st-degree connection of the sender (happy path), 1 lead where the primary is NOT 1st-degree of the sender (fallback path). If only the first is available, that's acceptable for v1 ship.

- [ ] **Step 2: Operator runs the campaign**

In the cockpit: launch CC+IC mode, point at the test sheet, click Start. Watch the live log.

- [ ] **Step 3: Verify happy-path log line**

For the 1st-degree lead, the log should show:

```
🤝 [<profile>] <leadUrl>: Voyager ok, convo=urn:li:msg_conversation:(...)
```

Expected: this line appears INSTEAD OF the old typeahead-based logging.

- [ ] **Step 4: Verify the sheet stamps `Introduction Made`**

Open the Google Sheet. The `Introduction Status` column for that lead should read `Introduction Made` and the cell background color should match the existing palette (unchanged — we didn't touch the Apps Script).

- [ ] **Step 5: Verify the group thread on LinkedIn**

In the sender's LinkedIn inbox, find the new thread. It should:
- Contain THREE participants: sender, lead, primary
- Have the personalized title from the wizard's `introTitle` field (e.g. "Introduction: Cindy <> Sam")
- Have the personalized body from the wizard's `primaryIntroBody` field

- [ ] **Step 6: Verify fallback path (if test data available)**

For the non-1st-degree-primary lead, the log should show:

```
↪ [<profile>] <leadUrl>: Voyager rejected (phase=post-non-200, reason=403) — falling back to typeahead
```

Followed by whatever the typeahead does today (which may itself fail and stamp `Failed` — that's the expected behavior, since the primary truly isn't reachable).

- [ ] **Step 7: Stop the campaign cleanly**

Click Stop in the cockpit. Verify no phantom Failed rows appear (operator rule: graceful abort is preserved from prior work).

---

## Task 11: Ship v2.51.0

- [ ] **Step 1: Bump version**

Edit `package.json`: change `"version": "2.50.0"` to `"version": "2.51.0"`.
Edit `package-lock.json`: change BOTH occurrences of `"version": "2.50.0"` (line 3 and line 9) to `"version": "2.51.0"`.

- [ ] **Step 2: Run the full suite one last time**

Run: `npm test`
Expected: green, no failures.

- [ ] **Step 3: Commit the version bump**

```bash
git add package.json package-lock.json
git commit -m "chore(release): bump version to 2.51.0"
```

- [ ] **Step 4: Push the branch**

Run: `git push origin connect-introduce-back-v2.14`
Expected: push succeeds.

- [ ] **Step 5: Fast-forward main**

Run:
```bash
git fetch origin main
git merge-base --is-ancestor origin/main connect-introduce-back-v2.14 && echo "FAST_FORWARD_SAFE" || echo "DIVERGED"
```

Expected: `FAST_FORWARD_SAFE`.

Then:
```bash
git push origin connect-introduce-back-v2.14:main
```

Expected: push succeeds.

- [ ] **Step 6: Build DMGs + publish v2.51.0**

Run: `npm run release:mac`
Expected: electron-builder produces both DMGs, then `gh release create v2.51.0` succeeds and prints the "Latest" URLs.

- [ ] **Step 7: Verify Latest now serves v2.51.0**

Run: `gh release list --repo ortusclub/ortus-outreach-installer --limit 3`
Expected: top row reads `Ortus Outreach 2.51.0 Latest v2.51.0`.

Run:
```bash
curl -sI "https://github.com/ortusclub/ortus-outreach-installer/releases/latest/download/Ortus-Outreach-arm64.dmg" | grep -i "location"
```

Expected: redirects to `releases/download/v2.51.0/Ortus-Outreach-arm64.dmg`.

---

## Self-review checklist (already run by the plan author)

**Spec coverage:**
- ✅ Voyager `createMessage` POST → Task 5 (payload), Task 6 (response), Task 7 (POST)
- ✅ URN resolution for lead, primary, sender → Tasks 2, 3, 4
- ✅ Title preserved as today → Task 5 (`conversationTitle` field in payload)
- ✅ Title retry-without-title fallback → Task 7 (`sendIntroViaVoyager` Attempt 2)
- ✅ DOM typeahead preserved as fallback → Task 8 (insertion, no deletion)
- ✅ `actions.js` and `outreach.js` untouched → Task 8 (`git diff` verification step)
- ✅ Sheet stamps unchanged (`Introduction Made`, `Failed`, etc.) → Task 8 (the `tracking` object built downstream is not touched)
- ✅ Tests for every pure helper → Tasks 2, 5, 6
- ✅ Manual end-to-end → Task 10
- ✅ Ship → Task 11

**Placeholder scan:** No "TBD", "add appropriate", "similar to Task N". All code is shown in full. All commands are exact.

**Type consistency:** `buildCreateMessagePayload`, `parseCreateMessageResponse`, `sendIntroViaVoyager`, `resolveProfileUrn`, `getSenderUrn`, `extractProfileUrnFromVoyagerResponse` — names are consistent across tasks and match the imports.

---

## Execution

Plan saved to `docs/superpowers/plans/2026-05-18-voyager-intro-send-plan.md`.
