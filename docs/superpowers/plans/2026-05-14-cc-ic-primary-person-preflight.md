# CC+IC Primary-Person Pre-flight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CC+IC campaigns refuse to start unless the configured Primary Person is provably reachable from every active sender account, and strengthen the in-campaign intro-DM typeahead matcher so near-misses (e.g. "Sam Ferrer" vs "Samuel Ferrer") no longer break intros.

**Architecture:** Two new files (a pure matcher helper + a per-profile verifier) plus one orchestrator. `src/campaign.js startCampaign()` eagerly launches all configured profiles, runs the orchestrator across them in parallel, and throws `PREFLIGHT_FAILED` if any fails — caught by the HTTP route and surfaced to the UI as a 409 with structured payload. The wizard's Primary Person URL field becomes required for CC+IC mode. UI shows a verifying spinner during pre-flight; on failure, a modal renders per-profile failure rows with a "Did you mean…" pill driven by the canonical name extracted from the primary person's actual LinkedIn profile.

**Tech Stack:** Node ≥22, puppeteer-core, vanilla JS/HTML/CSS, `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-14-cc-ic-primary-person-preflight-design.md`
**Sketch:** `public/sketches/preflight-primary-v1.html`

---

## Task 1: Pure matcher helper + tests

**Files:**
- Create: `src/linkedin/match-primary.js`
- Create: `tests/match-primary.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/match-primary.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPrimaryCandidate, normalizeName } from '../src/linkedin/match-primary.js';

test('normalizeName strips diacritics and lowercases', () => {
  assert.equal(normalizeName('José María'), 'jose maria');
  assert.equal(normalizeName('  Sam   Ferrer  '), 'sam ferrer');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
});

test('exact match: configured name appears verbatim in candidate', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Sam Ferrer · CEO at Ortus' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'exact');
  assert.equal(result.matchIndex, 0);
});

test('startsWith match: short configured name matches longer candidate', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Sam Ferrer · CEO' }],
    'Sam'
  );
  assert.equal(result.reason, 'exact');
});

test('token-prefix match: Sam Ferrer matches Samuel Ferrer', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Samuel Ferrer · CEO at Ortus' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'token-prefix');
  assert.equal(result.matchIndex, 0);
});

test('token-prefix non-match: Sam Ferrer does NOT match Sam Fernandez', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Sam Fernandez · CTO' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'no-match');
  assert.equal(result.matchIndex, null);
});

test('single-candidate fallback: only one result, click it even if name does not match', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'John Doe · CFO' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'single-candidate');
  assert.equal(result.matchIndex, 0);
});

test('multiple candidates, none match: no fallback', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'John Doe' }, { text: 'Jane Roe' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'no-match');
  assert.equal(result.matchIndex, null);
});

test('empty candidates array returns no-candidates', () => {
  const result = matchPrimaryCandidate([], 'Sam Ferrer');
  assert.equal(result.reason, 'no-candidates');
  assert.equal(result.matchIndex, null);
});

test('accent normalization: Jose Maria matches José María Pérez', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'José María Pérez · Engineer' }],
    'Jose Maria'
  );
  assert.equal(result.reason, 'token-prefix');
});

test('tier ordering: exact wins over single-candidate-fallback when both apply', () => {
  const result = matchPrimaryCandidate(
    [{ text: 'Sam Ferrer · CEO' }],
    'Sam Ferrer'
  );
  assert.equal(result.reason, 'exact');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/match-primary.test.js
```

Expected: All tests FAIL with `Cannot find module '../src/linkedin/match-primary.js'`.

- [ ] **Step 3: Implement the helper**

Create `src/linkedin/match-primary.js`:

```js
/**
 * Pure matcher for the LinkedIn typeahead dropdown when adding a recipient.
 *
 * Three-tier match, attempted in order:
 *   1. Exact / startsWith — configured name equals candidate OR candidate
 *      starts with `${configuredName} ` (catches "Sam" → "Sam Ferrer · CEO").
 *   2. Token-prefix — every whitespace token in the configured name is a
 *      prefix of some whitespace word in the candidate. Catches "Sam Ferrer"
 *      → "Samuel Ferrer".
 *   3. Single-candidate fallback — if LinkedIn returns exactly one suggestion,
 *      click it. Almost always correct for a name-based typeahead.
 *
 * Mirrored inline inside src/linkedin/actions.js sendIntroMessage's
 * page.evaluate block — when this file changes, that block must change too.
 * See the comment at the call site for details.
 */

export function normalizeName(v) {
  return (v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^remove\s+/, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Array<{text: string}>} candidates - candidate rows from the dropdown
 * @param {string} configuredName            - operator-configured primary name
 * @returns {{ matchIndex: number|null, reason: string }}
 *   reason: 'exact' | 'token-prefix' | 'single-candidate' | 'no-match' | 'no-candidates' | 'empty-config'
 */
export function matchPrimaryCandidate(candidates, configuredName) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { matchIndex: null, reason: 'no-candidates' };
  }
  const norm = normalizeName(configuredName);
  if (!norm) return { matchIndex: null, reason: 'empty-config' };

  // Tier 1: exact / startsWith
  for (let i = 0; i < candidates.length; i++) {
    const t = normalizeName(candidates[i].text);
    if (t === norm || t.startsWith(`${norm} `)) {
      return { matchIndex: i, reason: 'exact' };
    }
  }

  // Tier 2: token-prefix match
  const tokens = norm.split(/\s+/);
  for (let i = 0; i < candidates.length; i++) {
    const t = normalizeName(candidates[i].text);
    const words = t.split(/\s+/);
    const allMatched = tokens.every(tok => words.some(w => w.startsWith(tok)));
    if (allMatched) {
      return { matchIndex: i, reason: 'token-prefix' };
    }
  }

  // Tier 3: single-candidate fallback
  if (candidates.length === 1) {
    return { matchIndex: 0, reason: 'single-candidate' };
  }

  return { matchIndex: null, reason: 'no-match' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/match-primary.test.js
```

Expected: All 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/match-primary.js tests/match-primary.test.js
git commit -m "feat(cc-ic): pure matcher helper for primary-person typeahead

3-tier match (exact / token-prefix / single-candidate fallback) with 10
unit tests covering each tier, accent normalization, and edge cases.
Mirrored inline in sendIntroMessage's page.evaluate block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Upgrade `sendIntroMessage` matcher in `actions.js`

**Files:**
- Modify: `src/linkedin/actions.js:1408-1446` (the dropdown poll loop's matcher + error message)

**Context:** The original matcher is exact/startsWith-only inside a `page.evaluate` block. Page-evaluate cannot import Node modules, so the matcher logic is duplicated inline. Keep the pure helper in `match-primary.js` as the source of truth and the unit-tested reference; the inline copy here must stay in sync.

- [ ] **Step 1: Open the file and locate the matcher**

Read `src/linkedin/actions.js` lines 1385-1445. The `clickResult = await page.evaluate(async (name) => {...}, introName);` block is the target.

- [ ] **Step 2: Replace the matcher block**

Replace lines roughly 1408-1435 (the poll loop body) with this. The key changes: capture all candidate texts each iteration, apply the 3-tier matcher inline, click the matched index.

Find this block:

```js
      let lastCandidateCount = 0;
      let lastCandidatePreview = '';
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        const roots = Array.from(document.querySelectorAll(
          '.msg-connections-typeahead__search-results, [role="listbox"], .reusable-search__entity-result-list'
        ));
        const searchRoots = roots.length ? roots : [document];
        for (const root of searchRoots) {
          const candidates = Array.from(root.querySelectorAll(
            'li, [role="option"], button, .msg-connections-typeahead__search-result, .reusable-search__result-container'
          )).filter(isVisible);
          if (candidates.length > lastCandidateCount) {
            lastCandidateCount = candidates.length;
            lastCandidatePreview = candidates.slice(0, 3).map(c => (c.innerText || '').trim().split('\n')[0]).join(' | ');
          }
          const exact = candidates.find((c) => {
            const t = normalizeName(c.innerText || c.textContent);
            return t === norm || t.startsWith(`${norm} `);
          });
          if (exact) {
            activate(exact);
            return { ok: true, candidateCount: candidates.length, preview: lastCandidatePreview };
          }
        }
      }
      return { ok: false, candidateCount: lastCandidateCount, preview: lastCandidatePreview };
```

Replace with:

```js
      // 3-tier matcher (mirrors src/linkedin/match-primary.js — keep in sync).
      //   1. exact / startsWith
      //   2. token-prefix (each token in configured name must prefix some word in candidate)
      //   3. single-candidate fallback (only one suggestion: trust it)
      const matchOne = (cands) => {
        for (let i = 0; i < cands.length; i++) {
          const t = normalizeName(cands[i].innerText || cands[i].textContent);
          if (t === norm || t.startsWith(`${norm} `)) return { idx: i, reason: 'exact' };
        }
        const tokens = norm.split(/\s+/);
        for (let i = 0; i < cands.length; i++) {
          const t = normalizeName(cands[i].innerText || cands[i].textContent);
          const words = t.split(/\s+/);
          if (tokens.every(tok => words.some(w => w.startsWith(tok)))) {
            return { idx: i, reason: 'token-prefix' };
          }
        }
        if (cands.length === 1) return { idx: 0, reason: 'single-candidate' };
        return { idx: -1, reason: 'no-match' };
      };

      let lastCandidateCount = 0;
      let lastCandidatePreview = '';
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        const roots = Array.from(document.querySelectorAll(
          '.msg-connections-typeahead__search-results, [role="listbox"], .reusable-search__entity-result-list'
        ));
        const searchRoots = roots.length ? roots : [document];
        for (const root of searchRoots) {
          const candidates = Array.from(root.querySelectorAll(
            'li, [role="option"], button, .msg-connections-typeahead__search-result, .reusable-search__result-container'
          )).filter(isVisible);
          if (candidates.length > lastCandidateCount) {
            lastCandidateCount = candidates.length;
            lastCandidatePreview = candidates.slice(0, 3).map(c => (c.innerText || '').trim().split('\n')[0]).join(' | ');
          }
          const result = matchOne(candidates);
          if (result.idx >= 0) {
            activate(candidates[result.idx]);
            return { ok: true, candidateCount: candidates.length, preview: lastCandidatePreview, matchReason: result.reason };
          }
        }
      }
      return { ok: false, candidateCount: lastCandidateCount, preview: lastCandidatePreview };
```

- [ ] **Step 3: Update the success log line to include matchReason**

Find this line (roughly line 1437):

```js
    console.log(`[actions:intro] Dropdown poll result: ok=${clickResult.ok} candidates=${clickResult.candidateCount} preview="${clickResult.preview}"`);
```

Replace with:

```js
    console.log(`[actions:intro] Dropdown poll result: ok=${clickResult.ok} candidates=${clickResult.candidateCount} preview="${clickResult.preview}" matchReason=${clickResult.matchReason || 'n/a'}`);
```

- [ ] **Step 4: Update the error message to always include preview**

Find this block (roughly line 1442):

```js
      const detail = clickResult.candidateCount === 0
        ? 'recipient-not-in-results (dropdown never opened — confirm 1st-degree connection)'
        : `recipient-not-in-results (${clickResult.candidateCount} suggestions but no exact match; saw: ${clickResult.preview})`;
```

Replace with:

```js
      const detail = clickResult.candidateCount === 0
        ? 'recipient-not-in-results (dropdown never opened — confirm 1st-degree connection)'
        : `recipient-not-in-results (${clickResult.candidateCount} suggestions but no match; saw: ${clickResult.preview})`;
```

(Drops the word "exact" — now that we have 3 tiers, "no exact match" is misleading.)

- [ ] **Step 5: Run all existing tests to ensure no regression**

```bash
node --test tests/
```

Expected: All tests still pass (no test directly exercises this DOM code; pure-helper tests from Task 1 still pass).

- [ ] **Step 6: Manual smoke-test — relaunch dev:app**

Per CLAUDE.md operator rule #2:

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Wait ~5s, then verify the app launched without syntax errors:

```bash
grep -E "Error|SyntaxError|Cannot|Listening|Dashboard" /tmp/dev-app.log | tail -10
```

Expected: A `Dashboard: http://localhost:NNNN` line and no `Error` / `SyntaxError` lines. (Actual intro-DM behavior can only be tested by running a CC+IC campaign — defer to Task 10 end-to-end.)

- [ ] **Step 7: Commit**

```bash
git add src/linkedin/actions.js
git commit -m "feat(cc-ic): 3-tier matcher in sendIntroMessage typeahead

Replaces exact-only match with exact / token-prefix / single-candidate
fallback inline (mirrors src/linkedin/match-primary.js). Log line now
includes matchReason; error message no longer says 'no exact match'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `verifyPrimaryPerson` module

**Files:**
- Create: `src/linkedin/verify-primary-person.js`

**Context:** Per-profile verifier called by the pre-flight orchestrator. Runs against an already-launched, logged-in puppeteer page. Steps short-circuit on first failure (no point typing a name if the URL is invalid).

**Important:** This file duplicates ~30 lines from `sendIntroMessage` for the typeahead step (recipient-input tagging + page.type + dropdown poll + matcher). Per the off-limits constraint on `actions.js`, we cannot add a `verifyOnly` flag there. Duplication is acceptable; keep the comments explicit.

- [ ] **Step 1: Create the module**

Create `src/linkedin/verify-primary-person.js`:

```js
/**
 * Pre-flight verifier — checks the configured primary person can be reached
 * from a given sender account before any CC+IC connection requests go out.
 *
 * Returns one of:
 *   { ok: true,  canonicalName, candidates }
 *   { ok: false, failureType: 'url_invalid' | 'not_connected' | 'name_mismatch' | 'crash',
 *     canonicalName?, candidates?, detail }
 *
 * Spec: docs/superpowers/specs/2026-05-14-cc-ic-primary-person-preflight-design.md §4
 */

import { matchPrimaryCandidate } from './match-primary.js';

const PROFILE_NAV_TIMEOUT_MS = 15_000;
const TYPEAHEAD_POLL_ITER = 30;
const TYPEAHEAD_POLL_INTERVAL_MS = 200;

export async function verifyPrimaryPerson({
  page,
  profileName,
  primaryName,
  primaryUrl,
  log = console.log,
}) {
  if (!primaryName || !primaryUrl) {
    return { ok: false, failureType: 'config', detail: 'primaryName or primaryUrl missing' };
  }

  // ── Step 1: Visit primary URL ────────────────────────────────────────────
  try {
    await page.goto(primaryUrl, { waitUntil: 'domcontentloaded', timeout: PROFILE_NAV_TIMEOUT_MS });
  } catch (e) {
    log(`  [preflight:${profileName}] URL navigation failed: ${e.message}`);
    return { ok: false, failureType: 'url_invalid', detail: `Navigation failed: ${e.message}` };
  }
  // Catch "Page not found" / "This profile is not available"
  const pageMissing = await page.evaluate(() => {
    const t = (document.title || '').toLowerCase();
    const h1 = (document.querySelector('h1')?.innerText || '').toLowerCase();
    return t.includes('page not found') || t.includes("doesn't exist") ||
           h1.includes('page not found') || h1.includes('not available');
  });
  if (pageMissing) {
    return { ok: false, failureType: 'url_invalid', detail: `URL returned a not-found page: ${primaryUrl}` };
  }

  // ── Step 2: Extract canonical name from profile H1 ───────────────────────
  // Captured BEFORE the Message-button check so that not_connected failures
  // still carry the canonical name (helpful in debugging).
  const canonicalName = await page.evaluate(() => {
    const h1 = document.querySelector('h1.text-heading-xlarge, main h1, h1');
    return (h1?.innerText || '').trim().split('\n')[0].trim();
  });
  if (!canonicalName) {
    log(`  [preflight:${profileName}] Profile page loaded but no H1 found — DOM may have shifted`);
    return { ok: false, failureType: 'url_invalid', detail: 'Profile page loaded but no name H1 found' };
  }
  log(`  [preflight:${profileName}] Canonical name: "${canonicalName}"`);

  // ── Step 3: Check "Message" button presence (1st-degree proof) ───────────
  const hasMessageButton = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      'button, a, .pvs-profile-actions button, .pv-top-card button'
    ));
    return candidates.some(el => {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.innerText || '').toLowerCase().trim();
      return label.startsWith('message ') || label === 'message' ||
             text === 'message' || text.startsWith('message ');
    });
  });
  if (!hasMessageButton) {
    return {
      ok: false, failureType: 'not_connected', canonicalName,
      detail: 'No Message button on profile — not a 1st-degree connection',
    };
  }

  // ── Step 4: Typeahead test ───────────────────────────────────────────────
  // Navigate to a generic compose page. Use the sender's own messaging inbox
  // as a safe landing — opens the typeahead-capable recipient input without
  // needing a specific publicId.
  try {
    await page.goto('https://www.linkedin.com/messaging/?compose=true', {
      waitUntil: 'domcontentloaded', timeout: PROFILE_NAV_TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, failureType: 'crash', canonicalName, detail: `Compose nav failed: ${e.message}` };
  }
  await new Promise(r => setTimeout(r, 1200));

  // Find + tag the recipient input (same selector logic as sendIntroMessage).
  const tagged = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"][role="textbox"]'))
      .filter(isVisible);
    for (const el of inputs) {
      const text = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('class'),
        el.getAttribute('id'),
      ].join(' ').toLowerCase();
      if (text.includes('enter message recipients') || text.includes('msg-connections-typeahead__search-field')) {
        el.setAttribute('data-ortus-preflight', '1');
        return true;
      }
    }
    return false;
  });
  if (!tagged) {
    return { ok: false, failureType: 'crash', canonicalName, detail: 'Compose typeahead input not found' };
  }

  const sel = '[data-ortus-preflight="1"]';
  try {
    await page.click(sel);
    await page.type(sel, primaryName, { delay: 60 });
  } catch (e) {
    await page.evaluate(() => document.querySelector('[data-ortus-preflight="1"]')?.removeAttribute('data-ortus-preflight'));
    return { ok: false, failureType: 'crash', canonicalName, detail: `Type failed: ${e.message}` };
  }

  // Poll dropdown, gather candidate texts, run matcher in Node-side after each poll.
  let lastCandidates = [];
  for (let iter = 0; iter < TYPEAHEAD_POLL_ITER; iter++) {
    await new Promise(r => setTimeout(r, TYPEAHEAD_POLL_INTERVAL_MS));
    const cands = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const roots = Array.from(document.querySelectorAll(
        '.msg-connections-typeahead__search-results, [role="listbox"], .reusable-search__entity-result-list'
      ));
      const searchRoots = roots.length ? roots : [document];
      const out = [];
      for (const root of searchRoots) {
        const rows = Array.from(root.querySelectorAll(
          'li, [role="option"], button, .msg-connections-typeahead__search-result, .reusable-search__result-container'
        )).filter(isVisible);
        for (const r of rows) {
          const text = (r.innerText || r.textContent || '').trim().split('\n').slice(0, 2).join(' · ');
          if (text) out.push({ text });
        }
      }
      return out;
    });
    if (cands.length) lastCandidates = cands;
    const result = matchPrimaryCandidate(cands, primaryName);
    if (result.matchIndex !== null) {
      // Match found — pre-flight passes. We do NOT click; just clean up.
      await page.evaluate(() => document.querySelector('[data-ortus-preflight="1"]')?.removeAttribute('data-ortus-preflight'));
      const candidates = lastCandidates.slice(0, 3);
      log(`  [preflight:${profileName}] Typeahead matched: "${primaryName}" (reason=${result.reason})`);
      return { ok: true, canonicalName, candidates };
    }
  }

  // Out of polls — no match.
  await page.evaluate(() => document.querySelector('[data-ortus-preflight="1"]')?.removeAttribute('data-ortus-preflight'));
  return {
    ok: false, failureType: 'name_mismatch', canonicalName,
    candidates: lastCandidates.slice(0, 3),
    detail: lastCandidates.length === 0
      ? 'Dropdown never opened — typeahead may be broken or connection lost'
      : `${lastCandidates.length} suggestions but no match`,
  };
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/linkedin/verify-primary-person.js
```

Expected: No output (success).

- [ ] **Step 3: Smoke-import to verify exports**

```bash
node -e "import('./src/linkedin/verify-primary-person.js').then(m => console.log(Object.keys(m)))"
```

Expected: `[ 'verifyPrimaryPerson' ]`.

- [ ] **Step 4: Commit**

```bash
git add src/linkedin/verify-primary-person.js
git commit -m "feat(cc-ic): verifyPrimaryPerson module — per-profile preflight

Visits primary URL, extracts canonical name from H1, checks Message button
presence (proves 1st-degree), runs typeahead test using the 3-tier matcher.
Returns structured failureType for each of the 3 known failure modes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Pre-flight orchestrator + tests

**Files:**
- Create: `src/preflight-primary.js`
- Create: `tests/preflight-primary.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/preflight-primary.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../src/preflight-primary.js';

// Mock verifier — returns whatever is queued per profileName.
function mockVerifier(queue) {
  return async ({ profileName }) => {
    if (!queue.has(profileName)) {
      throw new Error(`unexpected profile: ${profileName}`);
    }
    const item = queue.get(profileName);
    if (item.delayMs) await new Promise(r => setTimeout(r, item.delayMs));
    if (item.throw) throw new Error(item.throw);
    return item.result;
  };
}

test('runPreflight: all profiles pass', async () => {
  const queue = new Map([
    ['a@x.com', { result: { ok: true, canonicalName: 'Sam Ferrer', candidates: [] } }],
    ['b@x.com', { result: { ok: true, canonicalName: 'Sam Ferrer', candidates: [] } }],
  ]);
  const out = await runPreflight({
    sessions: [
      { profileId: 'p1', profileName: 'a@x.com', page: {} },
      { profileId: 'p2', profileName: 'b@x.com', page: {} },
    ],
    primaryName: 'Sam Ferrer',
    primaryUrl: 'https://linkedin.com/in/sam',
    verifier: mockVerifier(queue),
  });
  assert.equal(out.allPassed, true);
  assert.equal(out.results.length, 2);
  assert.equal(out.results.every(r => r.ok), true);
});

test('runPreflight: one profile fails — allPassed false, results include failure detail', async () => {
  const queue = new Map([
    ['a@x.com', { result: { ok: true, canonicalName: 'Sam', candidates: [] } }],
    ['b@x.com', { result: { ok: false, failureType: 'name_mismatch', canonicalName: 'Samuel Ferrer', candidates: [{ text: 'Samuel Ferrer · CEO' }], detail: 'no match' } }],
  ]);
  const out = await runPreflight({
    sessions: [
      { profileId: 'p1', profileName: 'a@x.com', page: {} },
      { profileId: 'p2', profileName: 'b@x.com', page: {} },
    ],
    primaryName: 'Sam Ferrer',
    primaryUrl: 'https://linkedin.com/in/sam',
    verifier: mockVerifier(queue),
  });
  assert.equal(out.allPassed, false);
  const failed = out.results.find(r => r.profileName === 'b@x.com');
  assert.equal(failed.ok, false);
  assert.equal(failed.failureType, 'name_mismatch');
  assert.equal(failed.canonicalName, 'Samuel Ferrer');
});

test('runPreflight: verifier throws — captured as failureType crash', async () => {
  const queue = new Map([
    ['a@x.com', { throw: 'browser crashed' }],
  ]);
  const out = await runPreflight({
    sessions: [{ profileId: 'p1', profileName: 'a@x.com', page: {} }],
    primaryName: 'Sam Ferrer',
    primaryUrl: 'https://linkedin.com/in/sam',
    verifier: mockVerifier(queue),
  });
  assert.equal(out.allPassed, false);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].failureType, 'crash');
  assert.match(out.results[0].detail, /browser crashed/);
});

test('runPreflight: overall timeout — unfinished profiles reported as failureType timeout', async () => {
  const queue = new Map([
    ['fast@x.com', { result: { ok: true, canonicalName: 'X', candidates: [] } }],
    ['slow@x.com', { delayMs: 500, result: { ok: true, canonicalName: 'X', candidates: [] } }],
  ]);
  const out = await runPreflight({
    sessions: [
      { profileId: 'p1', profileName: 'fast@x.com', page: {} },
      { profileId: 'p2', profileName: 'slow@x.com', page: {} },
    ],
    primaryName: 'X',
    primaryUrl: 'u',
    verifier: mockVerifier(queue),
    overallTimeoutMs: 100,
  });
  assert.equal(out.allPassed, false);
  const slow = out.results.find(r => r.profileName === 'slow@x.com');
  assert.equal(slow.ok, false);
  assert.equal(slow.failureType, 'timeout');
});

test('runPreflight: empty sessions list returns allPassed=true', async () => {
  const out = await runPreflight({
    sessions: [],
    primaryName: 'X',
    primaryUrl: 'u',
    verifier: async () => ({ ok: true }),
  });
  assert.equal(out.allPassed, true);
  assert.equal(out.results.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/preflight-primary.test.js
```

Expected: All fail with `Cannot find module '../src/preflight-primary.js'`.

- [ ] **Step 3: Implement the orchestrator**

Create `src/preflight-primary.js`:

```js
/**
 * Pre-flight orchestrator — runs verifyPrimaryPerson across all active
 * sender profiles in parallel with an overall timeout.
 *
 * Spec: docs/superpowers/specs/2026-05-14-cc-ic-primary-person-preflight-design.md §6
 */

import { verifyPrimaryPerson as defaultVerifier } from './linkedin/verify-primary-person.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @param {object} args
 * @param {Array<{profileId, profileName, page}>} args.sessions
 * @param {string} args.primaryName
 * @param {string} args.primaryUrl
 * @param {Function} [args.log]
 * @param {number}   [args.overallTimeoutMs]
 * @param {Function} [args.verifier]  - DI hook for tests
 * @returns {Promise<{ allPassed: boolean, results: Array<object> }>}
 */
export async function runPreflight({
  sessions,
  primaryName,
  primaryUrl,
  log = () => {},
  overallTimeoutMs = DEFAULT_TIMEOUT_MS,
  verifier = defaultVerifier,
}) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { allPassed: true, results: [] };
  }

  // Per-profile promise: never rejects — always resolves with a result object.
  const perProfile = sessions.map(async (sess) => {
    try {
      const r = await verifier({
        page: sess.page,
        profileName: sess.profileName,
        primaryName,
        primaryUrl,
        log,
      });
      return { profileId: sess.profileId, profileName: sess.profileName, ...r };
    } catch (err) {
      return {
        profileId: sess.profileId,
        profileName: sess.profileName,
        ok: false,
        failureType: 'crash',
        detail: err.message,
      };
    }
  });

  // Race per-profile promises against an overall timeout. Profiles still
  // pending at the deadline are reported as failureType=timeout.
  const timeoutMarker = Symbol('timeout');
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve(timeoutMarker), overallTimeoutMs);
  });

  const settledOrTimeout = await Promise.race([
    Promise.all(perProfile),
    timeoutPromise,
  ]);

  let results;
  if (settledOrTimeout === timeoutMarker) {
    // Build results from whatever resolved; mark unresolved as timeout.
    results = await Promise.all(perProfile.map(async (p, i) => {
      const sess = sessions[i];
      const resolved = await Promise.race([
        p,
        new Promise((r) => setTimeout(() => r(null), 0)),
      ]);
      if (resolved) return resolved;
      return {
        profileId: sess.profileId,
        profileName: sess.profileName,
        ok: false,
        failureType: 'timeout',
        detail: `Verifier did not complete within ${overallTimeoutMs}ms`,
      };
    }));
  } else {
    results = settledOrTimeout;
  }

  return {
    allPassed: results.every(r => r.ok),
    results,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/preflight-primary.test.js
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preflight-primary.js tests/preflight-primary.test.js
git commit -m "feat(cc-ic): preflight orchestrator with timeout + 5 unit tests

Runs verifyPrimaryPerson across all sessions in parallel. Overall timeout
defaults to 60s. Verifier crashes captured as failureType=crash; unresolved
profiles at timeout marked as failureType=timeout. Verifier is DI'd for
unit testing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire pre-flight into `campaign.js startCampaign`

**Files:**
- Modify: `src/campaign.js` — `startCampaign()` function (starts at line 963)

**Context:** The current architecture launches profiles LAZILY via `ensureOpen()` inside the worker loop. Pre-flight requires all profiles launched up-front. The integration: after initial validation but before the worker loop, eager-launch each profile and run the orchestrator. On fail, close sessions + throw `PREFLIGHT_FAILED`. On pass, sessions are kept in the `sessions` Map and the worker loop's `ensureOpen` short-circuits on cache hit.

- [ ] **Step 1: Add import at top of `src/campaign.js`**

Find the existing imports near the top of `src/campaign.js`. Add this line alongside the other imports:

```js
import { runPreflight } from './preflight-primary.js';
```

- [ ] **Step 2: Locate the integration point**

In `src/campaign.js startCampaign()`, find the line where the worker-loop starts (search for the first call site of `ensureOpen` inside a loop, or the `// Worker loop` comment, or the `pickNextProfile` call). The integration point is AFTER initial sessions Map creation (line 1405 area) and the helper functions, but BEFORE the worker loop kicks off.

Specifically: find the first call to `ensureOpen` that happens inside a `for`/`while` loop processing the lead queue. Insert the pre-flight block at the top of that scope (after `ensureOpen` is defined but before any lead is processed).

If unclear, look for a marker like `// Phase 2:` comment or `pickNextProfile()` and insert just before.

- [ ] **Step 3: Insert the pre-flight block**

Insert this code at the integration point. **Adjust the variable names** to match the surrounding scope:
- `mode` is from the `startCampaign` argument
- `templates` is from the `startCampaign` argument; `templates.primaryName` and `templates.primaryUrl` are the configured fields
- `profileIds` is from the `startCampaign` argument
- `log` is the campaign's log function
- `sessions` is the Map of profileId → session

```js
    // ─────────────────────────────────────────────────────────────────────
    // Pre-flight: verify primary person is reachable from every sender
    // account before any connection requests go out. CC+IC only.
    //
    // Spec: docs/superpowers/specs/2026-05-14-cc-ic-primary-person-preflight-design.md
    // ─────────────────────────────────────────────────────────────────────
    if (mode === 'connect_and_introduce') {
      const primaryName = templates?.primaryName || '';
      const primaryUrl  = templates?.primaryUrl  || '';
      if (!primaryName || !primaryUrl) {
        const err = new Error('PREFLIGHT_FAILED');
        err.preflight = {
          allPassed: false,
          results: [{ profileName: 'config', ok: false, failureType: 'config',
                      detail: 'primaryName or primaryUrl missing — both are required for CC+IC' }],
        };
        throw err;
      }

      log(`📋 Pre-flight: verifying primary person on ${profileIds.length} account(s)…`);
      const launchedSessions = [];
      for (const pid of profileIds) {
        if (campaign._abort) break;
        const sess = await ensureOpen(pid);
        if (!sess) {
          launchedSessions.push({
            profileId: pid,
            profileName: profileNameCache[pid] || pid,
            page: null,
            launchFailed: true,
          });
        } else {
          launchedSessions.push({
            profileId: pid,
            profileName: sess.pName,
            page: sess.page,
          });
        }
      }

      // Profiles that failed to launch are treated as pre-flight failures.
      const launchFailures = launchedSessions
        .filter(s => s.launchFailed)
        .map(s => ({ profileId: s.profileId, profileName: s.profileName,
                     ok: false, failureType: 'launch_failed',
                     detail: 'Browser failed to launch — check GoLogin status' }));

      const verifiable = launchedSessions.filter(s => !s.launchFailed);
      const preflight = await runPreflight({
        sessions: verifiable,
        primaryName, primaryUrl, log,
      });
      preflight.results.push(...launchFailures);
      preflight.allPassed = preflight.allPassed && launchFailures.length === 0;

      if (!preflight.allPassed) {
        log(`❌ Pre-flight failed — campaign aborted.`);
        for (const r of preflight.results.filter(x => !x.ok)) {
          log(`   ${r.profileName}: ${r.failureType} — ${r.detail || ''}`);
        }
        // Close all launched sessions
        for (const [pid, sess] of sessions.entries()) {
          try { await sess.browser?.close(); } catch {}
          try { await sess.page?.close(); } catch {}
        }
        sessions.clear();
        campaign.running = false;
        const err = new Error('PREFLIGHT_FAILED');
        err.preflight = preflight;
        throw err;
      }
      log(`✓ Pre-flight verified primary person on ${verifiable.length}/${profileIds.length} accounts`);
    }
    // ─────────────────────────────────────────────────────────────────────
```

**Note on session teardown:** look at the existing teardown code at the end of `startCampaign()` (in the `finally` block) for the canonical close pattern, and use the same pattern in the pre-flight failure path. The snippet above is a reasonable best-effort; adjust to mirror the existing teardown shape (e.g. browser-semaphore release calls if those are part of cleanup).

- [ ] **Step 4: Verify no syntax errors**

```bash
node --check src/campaign.js
```

Expected: No output.

- [ ] **Step 5: Run existing tests**

```bash
node --test tests/
```

Expected: All pre-existing tests still pass.

- [ ] **Step 6: Relaunch dev:app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Wait ~5s, verify no errors:

```bash
grep -E "Error|SyntaxError|Cannot find|Listening|Dashboard" /tmp/dev-app.log | tail -10
```

Expected: `Dashboard:` line, no `Error` lines.

- [ ] **Step 7: Commit**

```bash
git add src/campaign.js
git commit -m "feat(cc-ic): eager-launch + run preflight before worker loop

CC+IC campaigns now launch all configured sender profiles up-front and run
the primary-person preflight orchestrator across them in parallel. On any
failure, tear down launched sessions and throw PREFLIGHT_FAILED with the
structured per-profile results attached. Other modes are unchanged (still
lazy-launch per worker-loop demand).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Server endpoint returns 409 on `PREFLIGHT_FAILED`

**Files:**
- Modify: `server.js:565-735` — `POST /api/campaign/start` handler

**Context:** When `startCampaign` throws an error with `err.message === 'PREFLIGHT_FAILED'`, return HTTP 409 with the `err.preflight` payload so the UI can render the failure modal. Other errors keep their existing handling.

- [ ] **Step 1: Locate the start route**

```bash
grep -n "app.post.*campaign/start" server.js
```

Confirms `server.js:565`.

- [ ] **Step 2: Read the handler to find its catch block**

Use the Read tool on `server.js` with `offset: 565, limit: 200` to inspect the route handler. Identify the existing `catch (err)` block — that's where the new branch goes.

- [ ] **Step 3: Add PREFLIGHT_FAILED handling**

Inside the `/api/campaign/start` handler's try/catch, add a check for the PREFLIGHT_FAILED error and return 409. The exact placement depends on the current structure — find the existing `catch (err)` block and prepend this branch:

```js
    if (err?.message === 'PREFLIGHT_FAILED' && err.preflight) {
      return res.status(409).json({
        error: 'preflight_failed',
        results: err.preflight.results,
      });
    }
```

The existing error handling for other errors stays unchanged.

- [ ] **Step 4: Verify no syntax errors**

```bash
node --check server.js
```

Expected: No output.

- [ ] **Step 5: Relaunch dev:app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Wait ~5s, verify:

```bash
grep -E "Error|SyntaxError|Listening|Dashboard" /tmp/dev-app.log | tail -10
```

Expected: `Dashboard:` line.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(cc-ic): return 409 PREFLIGHT_FAILED with structured payload

When startCampaign throws PREFLIGHT_FAILED, surface the per-profile failure
results to the UI via a 409 Conflict response. Existing error handling for
other failures is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wizard URL required for CC+IC mode

**Files:**
- Modify: `public/index.html:257-258` — Primary URL field label + placeholder
- Modify: `public/js/app.js:2397-2410` — click-time hard-block

**Context:** The wizard already has a Primary URL field (currently optional). Make it visually + functionally required when mode is CC+IC, mirroring the existing primaryName/primaryIntroBody hard-block pattern shipped in commit `6d9c130`.

- [ ] **Step 1: Update the Primary URL label**

Find line 257 in `public/index.html`:

```html
<label for="primary-person-url" style="display:block; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--gray); margin-bottom:4px;">LinkedIn profile URL <span style="text-transform:none;letter-spacing:0;color:var(--gray)">(optional)</span></label>
```

Replace with:

```html
<label for="primary-person-url" style="display:block; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--gray); margin-bottom:4px;">LinkedIn profile URL <span style="text-transform:none;letter-spacing:0;color:var(--red,#f85149)">*</span></label>
```

The `*` is the red asterisk indicating required.

- [ ] **Step 2: Update the click-time hard-block in app.js**

Find this block at `public/js/app.js:2397-2410`:

```js
    const _pName = (document.getElementById('primary-person-name')?.value || '').trim();
    const _pBody = (document.getElementById('primary-intro-body')?.value || '').trim();
    if (mode === 'connect_and_introduce' && (!_pName || !_pBody)) {
      const missing = [];
      if (!_pName) missing.push('Primary Person Name');
      if (!_pBody) missing.push('Intro DM Body');
      alert(`Cannot start Connect + Introduce Back campaign — please fill in:\n\n• ${missing.join('\n• ')}\n\nThese are needed so the bot can send the 3-way introduction message after each acceptance.`);
      // Scroll to + focus first empty
      const firstEmpty = !_pName ? 'primary-person-name' : 'primary-intro-body';
      const el = document.getElementById(firstEmpty);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => el.focus(), 300); }
      return;
    }
```

Replace with:

```js
    const _pName = (document.getElementById('primary-person-name')?.value || '').trim();
    const _pUrl  = (document.getElementById('primary-person-url')?.value  || '').trim();
    const _pBody = (document.getElementById('primary-intro-body')?.value || '').trim();
    if (mode === 'connect_and_introduce' && (!_pName || !_pUrl || !_pBody)) {
      const missing = [];
      if (!_pName) missing.push('Primary Person Name');
      if (!_pUrl)  missing.push('Primary Person LinkedIn URL');
      if (!_pBody) missing.push('Intro DM Body');
      alert(`Cannot start Connect + Introduce Back campaign — please fill in:\n\n• ${missing.join('\n• ')}\n\nThese are needed so the bot can send the 3-way introduction message after each acceptance.`);
      // Scroll to + focus first empty
      const firstEmpty = !_pName ? 'primary-person-name' : (!_pUrl ? 'primary-person-url' : 'primary-intro-body');
      const el = document.getElementById(firstEmpty);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => el.focus(), 300); }
      return;
    }
```

- [ ] **Step 3: Relaunch dev:app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 4: Manual verification**

Open the app, navigate to the campaign wizard, select Connect + Introduce Back mode. Confirm:
- The "LinkedIn profile URL" label shows a red `*` instead of "(optional)".
- Clicking Start with the URL field empty → alert lists "Primary Person LinkedIn URL" → URL field receives focus.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(cc-ic): require Primary URL for CC+IC mode

Wizard label changes (optional) → red asterisk. Click-time hard-block in
startCampaign() rejects empty URL and focuses the field. Mirrors the
existing primaryName/primaryIntroBody hard-block pattern from 6d9c130.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Pre-flight modal markup + CSS

**Files:**
- Modify: `public/index.html` — add modal markup near existing stop-choice-modal / restore-modal (around line 1108)
- Modify: `public/css/style.css` — add pre-flight modal styles

**Context:** The modal has three visual states (Verifying / All-clear / Failure). For simplicity, build one modal element with conditional sub-blocks toggled by a `data-state` attribute. The failure state renders per-profile rows dynamically from JS.

- [ ] **Step 1: Add modal HTML**

In `public/index.html`, find the closing tag of the restore-modal block (just after line 1108 starts the stop-choice-modal). Add this NEW modal markup right after the restore-modal block, before the stop-choice-modal:

```html
  <!-- Pre-flight verification modal (CC+IC primary person) -->
  <div id="preflight-modal" class="modal-backdrop hidden" data-state="verifying" onclick="if(event.target===this)closePreflightModal()">
    <div class="modal-card preflight-modal-card" role="dialog" aria-modal="true" aria-labelledby="preflight-modal-title">

      <!-- VERIFYING state -->
      <div class="preflight-state preflight-state-verifying">
        <div class="preflight-eyebrow">Pre-flight · in progress</div>
        <h3 id="preflight-modal-title" class="modal-title">Verifying primary person</h3>
        <p class="preflight-sub">
          Checking <strong id="preflight-primary-name">…</strong> is reachable from each sender account before the campaign starts. This takes about 15 seconds.
        </p>
        <div class="preflight-progress"><div class="preflight-progress-fill"></div></div>
        <div class="preflight-actions">
          <button class="btn-pill btn-pill-ghost" onclick="closePreflightModal()">Cancel</button>
        </div>
      </div>

      <!-- FAILURE state -->
      <div class="preflight-state preflight-state-failure" style="display:none">
        <div class="preflight-eyebrow">Pre-flight · campaign blocked</div>
        <h3 class="modal-title">Primary person can't be reached</h3>
        <div class="preflight-summary-banner">
          <div class="preflight-summary-icon">✕</div>
          <div class="preflight-summary-text">
            <strong id="preflight-fail-summary">…</strong>
            <small>Fix the issues below and try again. No connection requests have been sent.</small>
          </div>
        </div>
        <div id="preflight-failure-rows" class="preflight-rows"></div>
        <div class="preflight-actions">
          <button class="btn-pill btn-pill-ghost" onclick="closePreflightModal()">Cancel</button>
          <button class="btn-pill" onclick="closePreflightModalAndScrollToPrimary()">Edit primary person</button>
        </div>
      </div>

    </div>
  </div>
```

- [ ] **Step 2: Add CSS at the end of `public/css/style.css`**

Append:

```css
/* ─── Pre-flight verification modal ─────────────────────────────────────── */
.preflight-modal-card {
  max-width: 640px;
  width: 100%;
}
.preflight-eyebrow {
  font-size: 0.6rem;
  letter-spacing: 0.22em;
  color: var(--gray);
  text-transform: uppercase;
  margin-bottom: 14px;
}
.preflight-sub {
  font-size: 0.88rem;
  color: var(--gray);
  line-height: 1.55;
  margin-bottom: 22px;
}
.preflight-sub strong { color: var(--ink); font-weight: 500; }

/* Progress bar */
.preflight-progress {
  height: 2px;
  background: var(--hairline-soft);
  position: relative;
  margin-bottom: 22px;
  overflow: hidden;
}
.preflight-progress-fill {
  position: absolute; top: 0; left: 0; height: 100%;
  background: var(--ink); width: 35%;
  animation: preflight-progress 2.5s ease-in-out infinite;
}
@keyframes preflight-progress {
  0%   { width: 10%; }
  50%  { width: 75%; }
  100% { width: 100%; }
}

/* Summary banner (failure) */
.preflight-summary-banner {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border: 1px solid rgba(248, 81, 73, 0.4);
  margin-bottom: 18px;
}
.preflight-summary-icon {
  font-family: var(--display);
  font-size: 1.3rem;
  color: var(--red);
}
.preflight-summary-text {
  font-size: 0.82rem;
  color: var(--ink);
  line-height: 1.4;
}
.preflight-summary-text small {
  display: block;
  color: var(--gray);
  font-size: 0.72rem;
  margin-top: 2px;
}

/* Per-profile rows */
.preflight-rows {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--hairline-soft);
  margin-bottom: 18px;
}
.preflight-row {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  gap: 14px;
  align-items: start;
  padding: 12px 4px;
  border-bottom: 1px solid var(--hairline-soft);
}
.preflight-row:last-child { border-bottom: none; }
.preflight-row-icon {
  font-family: var(--display);
  font-size: 1.15rem;
  margin-top: 2px;
  color: var(--red);
}
.preflight-row-name {
  font-size: 0.85rem;
  color: var(--ink);
  font-weight: 500;
}
.preflight-row-detail {
  font-size: 0.72rem;
  color: var(--gray);
  margin-top: 3px;
  line-height: 1.4;
}
.preflight-row-detail strong {
  color: #d6a14a; /* amber accent — emphasis only */
  font-weight: 500;
}
.preflight-row-status {
  font-size: 0.58rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--red);
  white-space: nowrap;
}

/* Did-you-mean pill */
.preflight-suggestion-pill {
  font-size: 0.62rem;
  letter-spacing: 0.04em;
  border: 1px solid #d6a14a;
  color: #d6a14a;
  padding: 4px 10px;
  border-radius: 9999px;
  cursor: pointer;
  background: transparent;
  margin-top: 8px;
}
.preflight-suggestion-pill:hover {
  background: rgba(214, 161, 74, 0.08);
}

/* Actions row */
.preflight-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding-top: 18px;
  border-top: 1px solid var(--hairline-soft);
}
```

- [ ] **Step 3: Relaunch dev:app**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 4: Manual verification — temporarily show the modal**

Open the app's browser DevTools console and run:

```js
document.getElementById('preflight-modal').classList.remove('hidden');
document.getElementById('preflight-primary-name').textContent = 'Sam Ferrer';
```

Visually confirm: the modal appears, dark themed, with the progress bar animating. Click Cancel — does NOT yet work because handler isn't wired (Task 9). Manually hide via console:

```js
document.getElementById('preflight-modal').classList.add('hidden');
```

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/css/style.css
git commit -m "feat(cc-ic): preflight modal markup + styles

Three-state modal (verifying / failure) following the Bugatti command-deck
design system. Hairline borders, monochrome with red functional accent on
failure and amber on did-you-mean pills. JS wiring deferred to next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Pre-flight modal JS handlers

**Files:**
- Modify: `public/js/app.js` — add modal handlers + integrate with `startCampaign()` response handling

**Context:** Wire the modal to the campaign-start flow. When Start is clicked: show the modal in verifying state, POST `/api/campaign/start`, then on 409 transition the modal to failure state with rendered rows. The did-you-mean pill updates the primary-name input and re-submits the same body to `/api/campaign/start`.

- [ ] **Step 1: Add modal helpers near other modal handlers in app.js**

Find the existing `closeRestoreModal` / `closeStopChoiceModal` functions (they live together as a small cluster near each other in app.js — search for `closeRestoreModal`). Add these new functions in the same area:

```js
// ── Pre-flight modal ──────────────────────────────────────────────────────
let _preflightStartBody = null; // stashed start-campaign body for retry

function openPreflightModal(primaryName) {
  const modal = document.getElementById('preflight-modal');
  if (!modal) return;
  document.getElementById('preflight-primary-name').textContent = primaryName || '…';
  modal.dataset.state = 'verifying';
  modal.querySelector('.preflight-state-verifying').style.display = '';
  modal.querySelector('.preflight-state-failure').style.display = 'none';
  modal.classList.remove('hidden');
}

function showPreflightFailure(results, primaryName) {
  const modal = document.getElementById('preflight-modal');
  if (!modal) return;
  modal.dataset.state = 'failure';
  modal.querySelector('.preflight-state-verifying').style.display = 'none';
  modal.querySelector('.preflight-state-failure').style.display = '';

  const failed = results.filter(r => !r.ok);
  document.getElementById('preflight-fail-summary').textContent =
    `${primaryName} couldn't be verified on ${failed.length} of ${results.length} sender account${results.length === 1 ? '' : 's'}.`;

  const rowsEl = document.getElementById('preflight-failure-rows');
  rowsEl.innerHTML = '';
  for (const r of failed) {
    const row = document.createElement('div');
    row.className = 'preflight-row';
    row.innerHTML = `
      <div class="preflight-row-icon">✕</div>
      <div>
        <div class="preflight-row-name"></div>
        <div class="preflight-row-detail"></div>
        <div class="preflight-suggestion-holder"></div>
      </div>
      <div class="preflight-row-status"></div>
    `;
    row.querySelector('.preflight-row-name').textContent = r.profileName || r.profileId || 'unknown account';

    // Status label per failure type
    const statusMap = {
      url_invalid:   'URL not found',
      not_connected: 'Not connected',
      name_mismatch: 'Name mismatch',
      launch_failed: 'Launch failed',
      crash:         'Verification crashed',
      timeout:       'Timed out',
      config:        'Config missing',
    };
    row.querySelector('.preflight-row-status').textContent = statusMap[r.failureType] || 'Failed';

    // Detail text per failure type
    const detailEl = row.querySelector('.preflight-row-detail');
    if (r.failureType === 'name_mismatch' && r.canonicalName) {
      detailEl.innerHTML = `Profile loaded, but typeahead doesn't surface "${escapeHtml(primaryName)}". LinkedIn shows this person's name as <strong>${escapeHtml(r.canonicalName)}</strong>.`;
      const pill = document.createElement('button');
      pill.className = 'preflight-suggestion-pill';
      pill.textContent = `Use "${r.canonicalName}"`;
      pill.onclick = () => applyDidYouMeanAndRetry(r.canonicalName);
      row.querySelector('.preflight-suggestion-holder').appendChild(pill);
    } else if (r.failureType === 'not_connected') {
      detailEl.innerHTML = `Profile loads but no <strong>Message</strong> button — ${escapeHtml(primaryName)} is not a 1st-degree connection on this account. Intros from this account would fail every time.`;
    } else if (r.failureType === 'url_invalid') {
      detailEl.innerHTML = `Couldn't load the primary person's LinkedIn URL. ${escapeHtml(r.detail || '')}`;
    } else {
      detailEl.textContent = r.detail || 'Unknown failure';
    }
    rowsEl.appendChild(row);
  }
}

function closePreflightModal() {
  // Note: this closes the modal but does NOT abort an in-flight preflight
  // request — the orchestrator has a 60s overall timeout but no abort
  // signal. If the operator cancels while pre-flight is still running,
  // the request will either complete (with the campaign starting silently
  // if it passes) or 409 (with the failure modal NOT re-opening). For
  // typical 10-15s pre-flights this is acceptable; full abort-signal
  // plumbing is deferred. Worst case: operator clicks Stop on the running
  // campaign after pre-flight completes.
  const modal = document.getElementById('preflight-modal');
  if (modal) modal.classList.add('hidden');
  _preflightStartBody = null;
}

function closePreflightModalAndScrollToPrimary() {
  closePreflightModal();
  const nameInput = document.getElementById('primary-person-name');
  if (nameInput) {
    nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => nameInput.focus(), 300);
  }
}

async function applyDidYouMeanAndRetry(newName) {
  const nameInput = document.getElementById('primary-person-name');
  if (nameInput) {
    nameInput.value = newName;
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (!_preflightStartBody) return;
  // Update body with new name and re-submit. server.js destructures
  // primaryName from req.body root (server.js:878) and forwards into
  // templates before calling startCampaign — root update is enough.
  _preflightStartBody.primaryName = newName;
  openPreflightModal(newName);
  await submitStartCampaign(_preflightStartBody);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
```

- [ ] **Step 2: Refactor the start-campaign POST into a callable helper**

Find the existing `fetch('/api/campaign/start', ...)` call inside `startCampaign()` (around `public/js/app.js:2470-2490`, where `body` is constructed). Extract the actual `fetch` + response-handling into a new helper. Keep the existing body-construction; just replace the fetch call.

The body-construction stays:

```js
  const body = {
    profileIds: selectedProfileIds,
    sheetUrl,
    templates,
    primaryName: document.getElementById('primary-person-name')?.value?.trim() || '',
    primaryUrl:  document.getElementById('primary-person-url')?.value?.trim() || '',
    // ... whatever else is there
  };
```

Replace the fetch + result handling with:

```js
  await submitStartCampaign(body);
}

async function submitStartCampaign(body) {
  _preflightStartBody = body;
  const mode = body.mode || (body.templates && body.templates.mode) || '';
  const isCCIC = mode === 'connect_and_introduce';
  if (isCCIC) {
    openPreflightModal(body.primaryName || (body.templates && body.templates.primaryName) || '');
  }
  try {
    const res = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      const payload = await res.json();
      if (payload.error === 'preflight_failed') {
        showPreflightFailure(payload.results, body.primaryName || '');
        return;
      }
    }

    if (!res.ok) {
      const txt = await res.text();
      closePreflightModal();
      alert(`Could not start campaign:\n\n${txt}`);
      return;
    }

    // Success — close any open preflight modal, let normal post-start UI updates happen
    closePreflightModal();
    _preflightStartBody = null;
    // ... existing post-success logic (refresh state, switch UI to running, etc.)
    refreshState?.(); // adjust to whatever the existing code calls
  } catch (e) {
    closePreflightModal();
    alert(`Network error starting campaign:\n\n${e.message}`);
  }
}
```

**Note:** the existing `startCampaign` likely has additional post-success logic (toast, state refresh, UI transition). Move that logic INTO `submitStartCampaign` after the `closePreflightModal()` call. The agent must read the existing code and preserve the exact post-success behavior.

- [ ] **Step 3: Verify no syntax errors**

```bash
node --check public/js/app.js
```

(Note: node --check works on ES modules and plain JS; `public/js/app.js` is browser JS but is parseable as a script.)

If it errors with module syntax issues, instead verify by loading the app and watching the browser console:

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Wait ~5s, then check `/tmp/dev-app.log` for errors. Open the Electron app DevTools (Cmd+Option+I if visible) and reload — confirm no console errors.

- [ ] **Step 4: Manual verification flow**

In the running app:
1. Open the campaign wizard, select Connect + Introduce Back mode.
2. Fill in: profiles, sheet, templates, Primary Person Name = something deliberately wrong like `Bogus McNonexistent`, Primary URL = a real LinkedIn URL of someone you're connected to.
3. Click Start CTA.
4. Observe: pre-flight modal opens in verifying state, progress bar animates. After ~10-15s, modal transitions to failure state. The failed account row shows the `Name mismatch` status and a `Use "<canonicalName>"` pill.
5. Click the pill. Primary Person Name input updates to the canonical name. Modal returns to verifying state. After another ~10-15s, modal closes and the campaign begins (visible in the running state UI).
6. Stop the campaign to clean up.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "feat(cc-ic): preflight modal handlers + did-you-mean retry

Wires the preflight modal into the start-campaign flow. CC+IC clicks open
the verifying state, POST hits /api/campaign/start, 409 responses render
the failure state with per-profile rows. Did-you-mean pill updates the
primary-name input and re-submits transparently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: End-to-end manual verification

**Files:** None (verification only).

- [ ] **Step 1: Relaunch dev:app cleanly**

```bash
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null
npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Wait ~5s, capture the dashboard URL:

```bash
grep "Dashboard:" /tmp/dev-app.log | tail -1
```

- [ ] **Step 2: Test the happy path**

In the app:
1. Configure a small CC+IC campaign (1-2 leads, real sender profile, real primary person who IS a 1st-degree connection).
2. Click Start.
3. Verify: preflight modal opens → verifying spinner → modal closes within ~15s → campaign begins normally → leads receive connection requests.

- [ ] **Step 3: Test name-mismatch failure**

In the app:
1. Same setup as Step 2, but in Primary Person Name, type a deliberate misspelling (e.g. configured `Sammy` when LinkedIn says `Sam Ferrer`).
2. Click Start.
3. Verify: preflight modal opens → after ~15s, transitions to failure state → row shows `Name mismatch` + `Use "Sam Ferrer"` pill → pill click updates input + re-runs → modal closes → campaign begins.

- [ ] **Step 4: Test not-connected failure**

In the app:
1. Same setup but in Primary Person URL, paste a real LinkedIn profile of someone you are NOT connected to.
2. Click Start.
3. Verify: preflight modal → failure state → row shows `Not connected` with "no Message button" detail.

- [ ] **Step 5: Test URL-invalid failure**

In the app:
1. Set Primary Person URL to `https://www.linkedin.com/in/this-person-doesnt-exist-xyz-12345`.
2. Click Start.
3. Verify: preflight modal → failure state → row shows `URL not found`.

- [ ] **Step 6: Test empty-URL hard block (Task 7 regression)**

1. Open wizard in CC+IC mode, clear the Primary URL field, click Start.
2. Verify: alert lists "Primary Person LinkedIn URL"; URL field receives focus. Preflight modal does NOT open.

- [ ] **Step 7: Run the full test suite**

```bash
node --test tests/
```

Expected: All tests pass — including the new `match-primary.test.js` and `preflight-primary.test.js` plus all pre-existing tests.

- [ ] **Step 8: Commit (no code change — just push branch state)**

If everything passed, nothing to commit. Push the branch:

```bash
git push origin connect-introduce-back-v2.14
```

PR #17 picks up the new commits automatically.

---

## Out of scope (deferred)

Per the spec:
- Multi-recipient compose URL (`?recipient=A,B`) — possible cleaner long-term fix.
- Fuzzy name matching beyond token-prefix (Levenshtein, phonetic).
- Migrating existing on-disk campaigns to enforce URL.
- Apps Script changes (none needed).
- Real-time per-profile streaming in the verifying-state modal. Current implementation shows a single generic spinner during the 10-15s pre-flight; sketch shows per-row state transitions. Defer to a follow-up if the operator wants the live animation.
