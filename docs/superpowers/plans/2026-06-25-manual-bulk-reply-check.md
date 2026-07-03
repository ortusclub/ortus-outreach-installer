# Manual Bulk Reply Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, observable, identity-safe bulk inbox sweep that finds campaign-lead replies (and surfaces unmatched new replies) using LinkedIn's own `messengerConversations` Voyager call — preview-only by default, with opt-in sheet write-back.

**Architecture:** A new self-contained module `src/linkedin/inbox-sweep.js` holds pure matching/classification logic plus a preview-only per-profile sweep that reuses `helpers.getConversationsPage` + `fetchNewConversations` (one `/messaging/` nav per profile, zero per-thread opens). A server controller (`/api/reply-sweep/start|status|stop`) mirrors the FG team-launch streaming pattern: sequential per-profile sweep, isolated per-profile errors, force-close on stop. **Entry point:** the feature IS the existing **Check DMs** campaign type (`mode === 'check_dms'`), re-enabled from its greyed "Unavailable" state — NOT a dashboard card, drawer, or sidebar route. Selecting Check DMs always opens the **A3 split view** (a self-contained mode that takes over the main area like Follower Growth): a left list of replies (grouped campaign / unmatched) + a right read pane, with the "Check replies now" CTA, dry-run toggle (default ON), and streaming progress. `src/linkedin/check-dms.js` (the pure helpers + per-lead path) and the disabled scheduler are left untouched; only the `check_dms` *mode wiring* in the frontend is repointed to the new sweep.

**Tech Stack:** Node ≥22, vanilla JS + Express 4, puppeteer-core (browser fetches run in `page.evaluate` on the linkedin.com origin), `node --test`. No bundler, no new dependencies.

## Global Constraints

- Runtime Node ≥22; frontend vanilla JS, no bundler; Express 4. (CLAUDE.md)
- Tests run with `node --test tests/*.test.js` only — no Jest/Vitest. (CLAUDE.md)
- Off-limits — do NOT modify `src/linkedin/outreach.js` or `src/linkedin/actions.js`. (CLAUDE.md)
- Do NOT modify `src/linkedin/check-dms.js` or `src/post-campaign-reply-check.js` logic — the scheduler (disabled) and its tests depend on them. New behavior lives in new files. (spec: "No new scheduler logic (existing one untouched)")
- Bump `package.json` patch version before each relaunch of `npm run dev:app`; auto-relaunch after commits touching runtime code. (CLAUDE.md operator rules)
- Mutating/external actions ship opt-in: **dry-run defaults ON**; write-back is off until the operator turns dry-run off. (spec decision 6 + operator rule 4)
- Matching is identity-first, name only as fallback, skip-on-doubt → unmatched bucket, never guess. (spec decision 4)
- **Matching anchor is the NUMERIC memberId**, not the `/in/` slug. Live capture (2026-06-29, `docs/manual-bulk-reply-check-SCHEMA.md`) proved the sheet stores `/in/ACwAA…` while the inbox participant returns `/in/ACoAA…` — **different encodings, they never string-match**. The bridge is the numeric memberId: the sheet's `Linkedin Member` column (e.g. `269709976`) === the inbox participant `backendUrn: urn:li:member:269709976`, exposed by the parser as `participants[0].memberId`. Match order: memberId → ACoAA `fsdProfile` → name fallback.
- **PRECONDITION DONE (commit 37030d6, v2.122.0):** `helpers.getConversationsPage` was rewritten for the real `normalized+json+2.1` schema (it previously returned empty — why Check DMs looked dead). It now yields, per conversation: `participants[]` (self excluded; each with `firstName/lastName/profileUrl/memberId/fsdProfile/headline/photoUrl`), `lastMessage.{text,deliveredAt,actor,isInbound}`, `unreadCount`, `threadId`, `conversationUrl`, `groupChat`. Tasks below consume these fields directly — do NOT re-derive inbound from names when `lastMessage.isInbound` is present.
- Preview-only drill-in: use the `lastMessage` preview the bulk scan returns; ZERO extra tab opens. (spec decision 5)
- Bugatti command-deck design system for any UI: monochrome, hairlines, gold only on the primary CTA, radii 0 or 9999, tokens from `public/css/style.css`. (CLAUDE.md)
- Per-profile failures are isolated — one bad/rate-limited profile reports an error and the sweep continues. (spec: Error handling)
- Do NOT `git add data/monitoring-campaign.json` or other `data/*.json` runtime state. (memory)

---

## File Structure

- **Create `src/linkedin/inbox-sweep.js`** — pure matching/classification + preview-only sweep orchestration + dry-run-gated write-back. Owns: `identityToken`, `conversationToken`, `rowLinkedinUrl`, `isInboundConversation`, `matchConversationIdentitySafe`, `classifyConversations`, `makeInitialSweepStatus`, `applyReplyWriteBack`, `loadInboxConversations`, `sweepProfileInbox`, `_setDeps`.
- **Create `tests/inbox-sweep.test.js`** — `node --test` unit tests for all pure functions + the dry-run gate (via injected deps).
- **Create `public/sketches/2026-06-25-manual-reply-sweep.html`** — visual sketch of the panel + results view (built first, so the look is agreed before wiring).
- **Modify `public/sketches/index.html`** — index the new sketch.
- **Modify `server.js`** — add module state `_replySweep` / `_replySweepAbort` / `_replySweepHandle` and the three `/api/reply-sweep/*` endpoints, mirroring the FG team-launch block at `server.js:1536-1642`.
- **Modify `public/index.html`** — add the self-contained Check DMs / Reply-check section (A3 split: left reply list + right read pane, toolbar with dry-run toggle + CTA + progress). Shown only when `mode === 'check_dms'`.
- **Modify `public/js/app.js`** — (a) re-enable the `check_dms` card in `MODE_LIST` (remove `disabled`/`disabledReason`); (b) in `onModeChange`, when `mode === 'check_dms'` hide the normal campaign sections and reveal the A3 panel (mirror the Follower Growth self-contained-mode branch); (c) the A3 controller: start/poll/stop, dry-run toggle (default ON), render the grouped list + read pane + streaming logs.

---

## Task 1: Results-panel sketch (visual + intuitive)

Build the look first so the UI is agreed before any wiring. This directly addresses the requirement that the result view be visually good and intuitive.

**Files:**
- Create: `public/sketches/2026-06-25-manual-reply-sweep.html`
- Modify: `public/sketches/index.html` (add one card linking the sketch)

**Interfaces:**
- Consumes: nothing (static HTML).
- Produces: the agreed visual contract that Task 8 implements — a header row (title + dry-run toggle + "Check replies now" CTA + live progress eyebrow), a streaming log line, and two result sections: **Campaign replies** (matched leads) and **Unmatched new replies**.

- [ ] **Step 1: Build the sketch**

Create `public/sketches/2026-06-25-manual-reply-sweep.html` linking the real stylesheet (`<link rel="stylesheet" href="/css/style.css" />`) so it's 1:1 with the app. Show the panel in three states stacked on the page: (a) idle/empty, (b) running with streaming progress (e.g. "Scanning matt.adcock@… · 3/5 accounts · 12 conversations"), (c) results populated. Requirements:

- Header: section title "Reply check", a dry-run toggle reusing the `.alpha-toggle` track markup (label "Preview only — don't write to the sheet", shown **checked**), and a primary CTA button "Check replies now" (the only gold element). A right-aligned eyebrow chip shows live progress while running.
- A single streaming log line under the header (monospace, faint) — last message only.
- Two result sections with count badges: **Campaign replies** and **Unmatched new replies**. Each reply row: lead name (bold), faint profile URL/handle, the message snippet (1–2 lines, ellipsised), and a faint right-aligned timestamp. Unmatched rows that came from an ambiguous same-name match carry a small "same-name — unverified" tag.
- Empty states for each section ("No campaign replies found", "No unmatched replies").
- Monochrome + hairlines; gold only on the CTA; radii 0 or 9999; use tokens (`var(--ink)`, `var(--gray)`, `var(--hairline)`, `var(--gold)`, `var(--card-bg)`, `var(--mono)`).

- [ ] **Step 2: Index the sketch**

In `public/sketches/index.html`, immediately after the opening of the cards list (before the first existing `<a class="card" …>`), add:

```html
  <a class="card" href="2026-06-25-manual-reply-sweep.html" style="border-color:#F7BE68">
    <div class="card-label">MANUAL REPLY SWEEP · 2026-06-25</div>
    <div class="card-title">Reply check — panel + two-section results</div>
    <div class="card-desc">One-button bulk inbox sweep. Header with dry-run toggle (default ON) + gold CTA + live progress eyebrow; streaming log line; two sections (Campaign replies / Unmatched new replies) with count badges, snippets, timestamps, and a same-name "unverified" tag. Real app tokens, three states (idle / running / results).</div>
  </a>
```

- [ ] **Step 3: Verify visually**

Run: `node -e "require('fs').accessSync('public/sketches/2026-06-25-manual-reply-sweep.html')"` (expected: no output, exit 0). Then open `http://localhost:7847/sketches/2026-06-25-manual-reply-sweep.html` in the browser and confirm the three states read clearly and match the design system. (Manual visual check — no automated UI test in this repo.)

- [ ] **Step 4: Commit**

```bash
git add public/sketches/2026-06-25-manual-reply-sweep.html public/sketches/index.html
git commit -m "Manual reply sweep: results-panel sketch (two sections, dry-run toggle)"
```

---

## Task 2: Identity-token extraction (pure)

**Files:**
- Create: `src/linkedin/inbox-sweep.js`
- Test: `tests/inbox-sweep.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `identityToken(linkedinUrl: string) → string|null` — canonical match token from a LinkedIn URL: a member URN (`AC…`, case-preserved) if present, else the lowercased `/in/<slug>` vanity slug, else null.
  - `conversationToken(conv: object) → string|null` — `identityToken` of `conv.participants[0].profileUrl`.
  - `rowLinkedinUrl(row: object, linkedinColumn?: string) → string` — the row's LinkedIn URL: configured column first, then `'Linkedin URL'`, then first value containing `linkedin.com`, else `''`.

- [ ] **Step 1: Write the failing test**

Create `tests/inbox-sweep.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityToken, conversationToken, rowLinkedinUrl } from '../src/linkedin/inbox-sweep.js';

test('identityToken: vanity /in/ slug is lowercased', () => {
  assert.equal(identityToken('https://www.linkedin.com/in/Jane-Doe-123/'), 'jane-doe-123');
});

test('identityToken: member URN is preserved case-sensitively', () => {
  assert.equal(identityToken('https://www.linkedin.com/in/ACwAAB_xYz12'), 'ACwAAB_xYz12');
});

test('identityToken: sales lead URN', () => {
  assert.equal(identityToken('https://www.linkedin.com/sales/lead/ACwAAB_xYz12,NAME_SEARCH'), 'ACwAAB_xYz12');
});

test('identityToken: unrecognized → null', () => {
  assert.equal(identityToken('https://example.com/jane'), null);
  assert.equal(identityToken(''), null);
  assert.equal(identityToken(null), null);
});

test('conversationToken: from participant profileUrl', () => {
  const conv = { participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe-123' }] };
  assert.equal(conversationToken(conv), 'jane-doe-123');
});

test('conversationToken: no participant → null', () => {
  assert.equal(conversationToken({ participants: [] }), null);
  assert.equal(conversationToken({}), null);
});

test('rowLinkedinUrl: configured column wins, then fallback scan', () => {
  assert.equal(rowLinkedinUrl({ 'Linkedin URL': 'https://www.linkedin.com/in/a' }), 'https://www.linkedin.com/in/a');
  assert.equal(rowLinkedinUrl({ Profile: 'https://www.linkedin.com/in/b' }, 'Profile'), 'https://www.linkedin.com/in/b');
  assert.equal(rowLinkedinUrl({ Misc: 'see www.linkedin.com/in/c here' }), 'see www.linkedin.com/in/c here');
  assert.equal(rowLinkedinUrl({ Name: 'Jane' }), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/inbox-sweep.test.js`
Expected: FAIL — `Cannot find module '../src/linkedin/inbox-sweep.js'` (or "is not a function").

- [ ] **Step 3: Implement the functions**

Create `src/linkedin/inbox-sweep.js`:

```js
/**
 * Manual bulk reply sweep — identity-safe, preview-only inbox scan.
 *
 * Self-contained on purpose: reuses helpers.getConversationsPage +
 * fetchNewConversations but does NOT touch check-dms.js (the disabled
 * scheduler + its tests depend on it). Matching is identity-first
 * (URN/profileUrl), name only as a fallback, skip-on-doubt → unmatched.
 */

// Member-URN encoding shared with outreach.js / check-dms.js.
const SALES_MEMBER_URN_RE = /\/sales\/(?:lead|people)\/(AC[A-Za-z0-9_-]{10,})(?:[,/?#]|$)/;
const URN_RE = /^AC[A-Za-z0-9_-]+$/;

/** Canonical match token from a LinkedIn URL. URN (case-kept) > vanity slug (lowercased) > null. */
export function identityToken(linkedinUrl) {
  if (!linkedinUrl) return null;
  const url = String(linkedinUrl);
  const sales = url.match(SALES_MEMBER_URN_RE);
  if (sales) return sales[1];
  const inMatch = url.match(/\/in\/([^/?#,]+)/);
  if (inMatch) {
    const id = inMatch[1];
    return URN_RE.test(id) ? id : id.toLowerCase();
  }
  return null;
}

/** identityToken of the conversation's (single) participant. */
export function conversationToken(conv) {
  const p = Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null);
  return p ? identityToken(p.profileUrl) : null;
}

/** The row's LinkedIn URL: configured column > 'Linkedin URL' > first linkedin.com value > ''. */
export function rowLinkedinUrl(row, linkedinColumn) {
  if (!row || typeof row !== 'object') return '';
  if (linkedinColumn && row[linkedinColumn]) return String(row[linkedinColumn]);
  if (row['Linkedin URL']) return String(row['Linkedin URL']);
  for (const k of Object.keys(row)) {
    const v = String(row[k] || '');
    if (v.includes('linkedin.com')) return v;
  }
  return '';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/inbox-sweep.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/inbox-sweep.js tests/inbox-sweep.test.js
git commit -m "inbox-sweep: identity-token + row URL extraction (pure)"
```

---

## Task 3: Inbound detection + identity-safe matcher (pure)

**Files:**
- Modify: `src/linkedin/inbox-sweep.js`
- Test: `tests/inbox-sweep.test.js`

**Interfaces:**
- Consumes: `identityToken`, `conversationToken`, `rowLinkedinUrl` (Task 2).
- Produces:
  - `rowMemberId(row: object) → string` — the row's numeric memberId (`'Linkedin Member'` etc.), else `''`.
  - `isInboundConversation(conv: object) → boolean` — prefers `conv.lastMessage.isInbound` (parser-authoritative); falls back to actor profileUrl/name comparison for shapes without it.
  - `matchConversationIdentitySafe(conv, candidateRows: object[], linkedinColumn?: string) → { row: object|null, reason: 'identity'|'name'|'unmatched'|'ambiguous' }` — tries in order: (1) numeric memberId, (2) ACoAA `fsdProfile`, (3) legacy slug token, (4) name fallback. At each stage exactly one hit → `identity` (or `name` for stage 4); >1 → `ambiguous` (skip-on-doubt); 0 → next stage; all empty → `unmatched`.

- [ ] **Step 1: Write the failing test**

Append to `tests/inbox-sweep.test.js`:

```js
import { isInboundConversation, matchConversationIdentitySafe } from '../src/linkedin/inbox-sweep.js';

const inboundConv = (over = {}) => ({
  participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' }],
  lastMessage: { text: 'thanks!', deliveredAt: 1000, actor: { firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' } },
  ...over,
});

test('isInboundConversation: lead sent last message (profileUrl match)', () => {
  assert.equal(isInboundConversation(inboundConv()), true);
});

test('isInboundConversation: we sent last message (actor differs) → false', () => {
  const conv = inboundConv({ lastMessage: { text: 'hi', actor: { firstName: 'Matt', lastName: 'Adcock', profileUrl: 'https://www.linkedin.com/in/matt' } } });
  assert.equal(isInboundConversation(conv), false);
});

test('isInboundConversation: no lastMessage → false', () => {
  assert.equal(isInboundConversation({ participants: [{ firstName: 'Jane', lastName: 'Doe' }] }), false);
});

test('matcher: numeric memberId is the primary anchor across the ACwAA/ACoAA gap', () => {
  // Real-world shape: sheet stores ACwAA + numeric memberId; inbox gives ACoAA + same memberId.
  const conv = { participants: [{ firstName: 'Luca', lastName: 'Coppone', memberId: '269709976', fsdProfile: 'ACoAABATcpgBDDx_VOd0lhUz_ZFcIhV21cuJuw8', profileUrl: 'https://www.linkedin.com/in/ACoAABATcpgBDDx_VOd0lhUz_ZFcIhV21cuJuw8' }],
    lastMessage: { text: 'grazie', deliveredAt: 1, isInbound: true } };
  const rows = [
    { 'First Name': 'Other', 'Last Name': 'Person', 'Linkedin Member': '111111111', 'Linkedin URL': 'https://www.linkedin.com/in/ACwAAsomeoneelse' },
    { 'First Name': 'Luca', 'Last Name': 'Coppone', 'Linkedin Member': '269709976', 'Linkedin URL': 'http://www.linkedin.com/in/ACwAABATcpgBWoI4yCYrBfmpcpJA0zLKtvoJUic' },
  ];
  const res = matchConversationIdentitySafe(conv, rows, 'Linkedin URL');
  assert.equal(res.reason, 'identity');
  assert.equal(res.row['First Name'], 'Luca');
});

test('matcher: two rows share the memberId → ambiguous, no row', () => {
  const conv = { participants: [{ firstName: 'Luca', lastName: 'Coppone', memberId: '269709976' }], lastMessage: { text: 'x', isInbound: true } };
  const rows = [
    { 'First Name': 'Luca', 'Last Name': 'Coppone', 'Linkedin Member': '269709976' },
    { 'First Name': 'Luca', 'Last Name': 'Coppone', 'Linkedin Member': '269709976' },
  ];
  assert.equal(matchConversationIdentitySafe(conv, rows).reason, 'ambiguous');
});

test('matcher: identity-token match wins (slug, when no memberId present)', () => {
  const rows = [
    { 'First Name': 'Other', 'Last Name': 'Person', 'Linkedin URL': 'https://www.linkedin.com/in/someone-else' },
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' },
  ];
  const res = matchConversationIdentitySafe(inboundConv(), rows);
  assert.equal(res.reason, 'identity');
  assert.equal(res.row['First Name'], 'Jane');
});

test('matcher: two rows share the token → ambiguous, no row', () => {
  const rows = [
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' },
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' },
  ];
  const res = matchConversationIdentitySafe(inboundConv(), rows);
  assert.equal(res.reason, 'ambiguous');
  assert.equal(res.row, null);
});

test('matcher: name fallback when no token on either side', () => {
  // Conversation participant has no profileUrl → no token; match by name.
  const conv = { participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: '' }], lastMessage: { text: 'hi', actor: { firstName: 'Jane', lastName: 'Doe' } } };
  const rows = [{ 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' }];
  const res = matchConversationIdentitySafe(conv, rows);
  assert.equal(res.reason, 'name');
  assert.equal(res.row['First Name'], 'Jane');
});

test('matcher: two same-name rows with no token → ambiguous (skip-on-doubt)', () => {
  const conv = { participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: '' }], lastMessage: { text: 'hi', actor: { firstName: 'Jane', lastName: 'Doe' } } };
  const rows = [
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' },
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' },
  ];
  assert.equal(matchConversationIdentitySafe(conv, rows).reason, 'ambiguous');
});

test('matcher: nothing matches → unmatched', () => {
  const rows = [{ 'First Name': 'Nobody', 'Last Name': 'Here', 'Linkedin URL': 'https://www.linkedin.com/in/nobody' }];
  assert.equal(matchConversationIdentitySafe(inboundConv(), rows).reason, 'unmatched');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/inbox-sweep.test.js`
Expected: FAIL — `isInboundConversation is not a function`.

- [ ] **Step 3: Implement the functions**

Append to `src/linkedin/inbox-sweep.js`:

```js
function normName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function fullName(firstName, lastName) {
  return `${normName(firstName)} ${normName(lastName)}`.trim();
}

/** Numeric memberId from a sheet row ('Linkedin Member' / 'Linkedin Member ID' / 'memberId'). */
export function rowMemberId(row) {
  if (!row || typeof row !== 'object') return '';
  for (const k of ['Linkedin Member', 'LinkedIn Member', 'Linkedin Member ID', 'memberId', 'Member ID']) {
    const v = String(row[k] ?? '').trim();
    if (/^\d{4,}$/.test(v)) return v;
  }
  // Fallback: any column whose value is a bare numeric id of plausible length.
  for (const k of Object.keys(row)) {
    const v = String(row[k] ?? '').trim();
    if (/^\d{6,}$/.test(v)) return v;
  }
  return '';
}

/**
 * True when the lead sent the last message. Prefer the parser's authoritative
 * `lastMessage.isInbound` (sender ≠ viewer); fall back to actor/name comparison
 * only for legacy/test shapes that don't carry it.
 */
export function isInboundConversation(conv) {
  const last = conv?.lastMessage || null;
  if (!last) return false;
  if (typeof last.isInbound === 'boolean') return last.isInbound;
  const participant = Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null);
  if (!participant) return false;
  const actor = last.actor || {};
  const sameUrl = participant.profileUrl && actor.profileUrl && participant.profileUrl === actor.profileUrl;
  const sameName = participant.firstName && actor.firstName &&
    fullName(participant.firstName, participant.lastName) === fullName(actor.firstName, actor.lastName);
  return !!(sameUrl || sameName);
}

/**
 * Identity-first match. Token (URN/slug) exact match first; name only when the
 * token side is empty on either party. >1 candidate at any stage → ambiguous
 * (skip-on-doubt) so we never stamp the wrong row.
 */
export function matchConversationIdentitySafe(conv, candidateRows, linkedinColumn) {
  const rows = Array.isArray(candidateRows) ? candidateRows : [];
  const participant0 = Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null);

  // 1. Numeric memberId — the only anchor that survives the ACwAA(sheet)/ACoAA(inbox)
  //    encoding gap. Exact, free (both sides already carry it).
  const cMemberId = String(participant0?.memberId || '').trim();
  if (/^\d{4,}$/.test(cMemberId)) {
    const hits = rows.filter((r) => rowMemberId(r) === cMemberId);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
    // 0 → fall through (sheet row may predate memberId capture).
  }

  // 2. ACoAA fsd_profile token — secondary exact key when memberId is blank on a side.
  const cFsd = String(participant0?.fsdProfile || '').trim();
  if (cFsd) {
    const hits = rows.filter((r) => identityToken(rowLinkedinUrl(r, linkedinColumn)) === cFsd
      || String(r['LinkedIn URN'] || r['Linkedin URN'] || '').trim() === cFsd);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }

  // 3. Legacy slug token (only matches when both sides share an encoding).
  const ctoken = conversationToken(conv);
  if (ctoken) {
    const hits = rows.filter((r) => identityToken(rowLinkedinUrl(r, linkedinColumn)) === ctoken);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }

  const participant = participant0;
  const convFull = participant ? fullName(participant.firstName, participant.lastName) : '';
  if (!convFull) return { row: null, reason: 'unmatched' };

  const nameHits = rows.filter((r) =>
    fullName(r.firstName || r['First Name'], r.lastName || r['Last Name']) === convFull);
  if (nameHits.length === 1) return { row: nameHits[0], reason: 'name' };
  if (nameHits.length > 1) return { row: null, reason: 'ambiguous' };
  return { row: null, reason: 'unmatched' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/inbox-sweep.test.js`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/inbox-sweep.js tests/inbox-sweep.test.js
git commit -m "inbox-sweep: inbound detection + identity-safe matcher (pure)"
```

---

## Task 4: Conversation classifier (pure)

**Files:**
- Modify: `src/linkedin/inbox-sweep.js`
- Test: `tests/inbox-sweep.test.js`

**Interfaces:**
- Consumes: `isInboundConversation`, `matchConversationIdentitySafe`, `rowLinkedinUrl` (Tasks 2–3).
- Produces:
  - `classifyConversations(convs: object[], candidateRows: object[], linkedinColumn?: string) → { campaignReplies: Reply[], unmatched: Reply[] }` where each `Reply` is `{ leadName, snippet, profileUrl, threadId, timestamp, linkedinUrl, row, suspected }`. Only inbound conversations are considered. `identity`/`name` → campaignReplies; `ambiguous` → unmatched with `suspected: true`; `unmatched` → unmatched with `suspected: false`.

- [ ] **Step 1: Write the failing test**

Append to `tests/inbox-sweep.test.js`:

```js
import { classifyConversations } from '../src/linkedin/inbox-sweep.js';

test('classify: splits matched vs unmatched, skips outbound', () => {
  const convs = [
    // inbound, matches a row by token → campaign reply
    { threadId: 't1', lastActivityAt: 10,
      participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' }],
      lastMessage: { text: 'thanks for connecting!', deliveredAt: 9, actor: { firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' } } },
    // inbound, no matching row → unmatched new reply
    { threadId: 't2', lastActivityAt: 20,
      participants: [{ firstName: 'Stranger', lastName: 'Person', profileUrl: 'https://www.linkedin.com/in/stranger' }],
      lastMessage: { text: 'hi there', deliveredAt: 19, actor: { firstName: 'Stranger', lastName: 'Person', profileUrl: 'https://www.linkedin.com/in/stranger' } } },
    // outbound (we sent last) → ignored entirely
    { threadId: 't3', lastActivityAt: 30,
      participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' }],
      lastMessage: { text: 'following up', deliveredAt: 29, actor: { firstName: 'Matt', lastName: 'Adcock', profileUrl: 'https://www.linkedin.com/in/matt' } } },
  ];
  const rows = [{ 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' }];
  const { campaignReplies, unmatched } = classifyConversations(convs, rows);
  assert.equal(campaignReplies.length, 1);
  assert.equal(campaignReplies[0].leadName, 'Jane Doe');
  assert.equal(campaignReplies[0].threadId, 't1');
  assert.equal(campaignReplies[0].linkedinUrl, 'https://www.linkedin.com/in/jane-doe');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].leadName, 'Stranger Person');
  assert.equal(unmatched[0].suspected, false);
});

test('classify: ambiguous same-name → unmatched with suspected:true', () => {
  const convs = [{ threadId: 'a', lastActivityAt: 5,
    participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: '' }],
    lastMessage: { text: 'hey', deliveredAt: 4, actor: { firstName: 'Jane', lastName: 'Doe' } } }];
  const rows = [
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' },
    { 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': '' },
  ];
  const { campaignReplies, unmatched } = classifyConversations(convs, rows);
  assert.equal(campaignReplies.length, 0);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].suspected, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/inbox-sweep.test.js`
Expected: FAIL — `classifyConversations is not a function`.

- [ ] **Step 3: Implement the function**

Append to `src/linkedin/inbox-sweep.js`:

```js
function previewOf(conv, row, linkedinColumn) {
  const p = Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null);
  const last = conv?.lastMessage || null;
  return {
    leadName: p ? `${p.firstName || ''} ${p.lastName || ''}`.replace(/\s+/g, ' ').trim() : '(unknown)',
    snippet: String(last?.text || '').slice(0, 160),
    profileUrl: p?.profileUrl || '',
    threadId: conv?.threadId || '',
    timestamp: last?.deliveredAt || conv?.lastActivityAt || null,
    linkedinUrl: row ? rowLinkedinUrl(row, linkedinColumn) : (p?.profileUrl || ''),
    row: row || null,
    suspected: false,
  };
}

/** Split inbound conversations into matched campaign replies vs unmatched new replies. */
export function classifyConversations(convs, candidateRows, linkedinColumn) {
  const campaignReplies = [];
  const unmatched = [];
  for (const conv of (Array.isArray(convs) ? convs : [])) {
    if (!isInboundConversation(conv)) continue;
    const m = matchConversationIdentitySafe(conv, candidateRows, linkedinColumn);
    if (m.reason === 'identity' || m.reason === 'name') {
      campaignReplies.push(previewOf(conv, m.row, linkedinColumn));
    } else {
      const item = previewOf(conv, null, linkedinColumn);
      item.suspected = (m.reason === 'ambiguous');
      unmatched.push(item);
    }
  }
  return { campaignReplies, unmatched };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/inbox-sweep.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/inbox-sweep.js tests/inbox-sweep.test.js
git commit -m "inbox-sweep: conversation classifier (campaign vs unmatched)"
```

---

## Task 5: Sweep status model + dry-run write-back gate

**Files:**
- Modify: `src/linkedin/inbox-sweep.js`
- Test: `tests/inbox-sweep.test.js`

**Interfaces:**
- Consumes: `classifyConversations` (Task 4) shapes.
- Produces:
  - `makeInitialSweepStatus(profileNames: string[], dryRun: boolean) → status` — `{ running:true, phase:'scanning', dryRun, totalProfiles, doneProfiles:0, currentProfile:null, campaignReplies:[], unmatched:[], perProfile:[{profileName,status:'waiting',replies:0,unmatched:0,error:''}], logs:[], wrote:0, error:null }`.
  - `applyReplyWriteBack({ sheetUrl, linkedinColumn, campaignReplies, deps }) → { wrote, skipped, errors }` — for each matched reply: non-destructive `getSheetRowStatus`→`shouldWriteReply` guard, then `updateSheetRow` (`Reply:'yes'`, `ReplyAt`, `ReplyPreview`, `stage:'Replied'`) + `appendReplyRow`. Never called in dry-run.
  - `_setDeps(stubs|null)` — test hook (mirrors check-dms.js `_setDeps`).
  - `shouldWriteReply(currentStatus, _newReply) → boolean` — re-exported helper (non-destructive predicate).

- [ ] **Step 1: Write the failing test**

Append to `tests/inbox-sweep.test.js`:

```js
import { makeInitialSweepStatus, applyReplyWriteBack, _setDeps } from '../src/linkedin/inbox-sweep.js';

test('makeInitialSweepStatus: shape + dryRun flag', () => {
  const s = makeInitialSweepStatus(['a@x.com', 'b@x.com'], true);
  assert.equal(s.running, true);
  assert.equal(s.dryRun, true);
  assert.equal(s.totalProfiles, 2);
  assert.equal(s.perProfile.length, 2);
  assert.equal(s.perProfile[0].status, 'waiting');
});

test('applyReplyWriteBack: writes matched replies via deps, honors non-destructive guard', async () => {
  const calls = { update: [], append: [] };
  _setDeps({
    async getSheetRowStatus() { return { Reply: '' }; },          // empty → should write
    async updateSheetRow(sheetUrl, url, tracking) { calls.update.push({ url, tracking }); },
    async appendReplyRow(sheetUrl, reply) { calls.append.push(reply); },
  });
  const campaignReplies = [
    { leadName: 'Jane Doe', snippet: 'thanks', linkedinUrl: 'https://www.linkedin.com/in/jane-doe', timestamp: 1000, row: { 'First Name': 'Jane', 'Last Name': 'Doe' } },
  ];
  const out = await applyReplyWriteBack({ sheetUrl: 'S', linkedinColumn: 'Linkedin URL', campaignReplies, deps: undefined });
  assert.equal(out.wrote, 1);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].tracking.Reply, 'yes');
  assert.equal(calls.update[0].tracking.stage, 'Replied');
  assert.equal(calls.append.length, 1);
  _setDeps(null);
});

test('applyReplyWriteBack: skips rows already marked Reply=yes', async () => {
  const calls = { update: [] };
  _setDeps({
    async getSheetRowStatus() { return { Reply: 'yes' }; },        // already replied → skip
    async updateSheetRow(s, u, t) { calls.update.push(t); },
    async appendReplyRow() {},
  });
  const out = await applyReplyWriteBack({ sheetUrl: 'S', linkedinColumn: 'Linkedin URL',
    campaignReplies: [{ leadName: 'Jane', snippet: 'hi', linkedinUrl: 'https://www.linkedin.com/in/jane-doe', timestamp: 1, row: {} }], deps: undefined });
  assert.equal(out.wrote, 0);
  assert.equal(out.skipped, 1);
  assert.equal(calls.update.length, 0);
  _setDeps(null);
});

test('applyReplyWriteBack: missing linkedinUrl → counted as error, no throw', async () => {
  _setDeps({ async getSheetRowStatus() { return { Reply: '' }; }, async updateSheetRow() {}, async appendReplyRow() {} });
  const out = await applyReplyWriteBack({ sheetUrl: 'S', linkedinColumn: 'Linkedin URL',
    campaignReplies: [{ leadName: 'NoUrl', snippet: 'x', linkedinUrl: '', timestamp: 1, row: {} }], deps: undefined });
  assert.equal(out.wrote, 0);
  assert.equal(out.errors.length, 1);
  _setDeps(null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/inbox-sweep.test.js`
Expected: FAIL — `makeInitialSweepStatus is not a function`.

- [ ] **Step 3: Implement the model + write-back + deps**

Append to `src/linkedin/inbox-sweep.js`. Add the imports at the TOP of the file (move them above the regex consts):

```js
import * as helpers from './helpers.js';
import { updateSheetRow, appendReplyRow as _appendReplyRow } from '../sheets-writer.js';
import * as sheetsWriter from '../sheets-writer.js';
```

Then append:

```js
// ── Dependency injection (test hook; mirrors check-dms.js) ───────────────────
const _realDeps = {
  async getConversationsPage(page, opts) { return helpers.getConversationsPage(page, opts); },
  async getSheetRowStatus(sheetUrl, url, col) { return sheetsWriter.getSheetRowStatus(sheetUrl, url, col); },
  async updateSheetRow(sheetUrl, url, tracking, col) { return updateSheetRow(sheetUrl, url, tracking, col); },
  async appendReplyRow(sheetUrl, reply) { return _appendReplyRow(sheetUrl, reply); },
};
let _deps = { ..._realDeps };
export function _setDeps(stubs) { _deps = stubs === null ? { ..._realDeps } : { ..._realDeps, ...stubs }; }

/** Non-destructive: don't overwrite a row already marked Reply=yes. */
export function shouldWriteReply(currentStatus, _newReply) {
  if (!currentStatus) return true;
  return String(currentStatus.Reply || '').toLowerCase().trim() !== 'yes';
}

export function makeInitialSweepStatus(profileNames, dryRun) {
  const names = Array.isArray(profileNames) ? profileNames : [];
  return {
    running: true, phase: 'scanning', dryRun: !!dryRun,
    totalProfiles: names.length, doneProfiles: 0, currentProfile: null,
    campaignReplies: [], unmatched: [], wrote: 0,
    perProfile: names.map((n) => ({ profileName: n, status: 'waiting', replies: 0, unmatched: 0, error: '' })),
    logs: [], error: null,
  };
}

/**
 * Write matched campaign replies to the sheet (Replies tab + Reply/Stage).
 * Non-destructive + per-row isolated. Only called when dry-run is OFF.
 */
export async function applyReplyWriteBack({ sheetUrl, linkedinColumn, campaignReplies }) {
  let wrote = 0, skipped = 0;
  const errors = [];
  for (const r of (campaignReplies || [])) {
    const url = r.linkedinUrl || '';
    if (!url) { errors.push(`missing LinkedIn URL for ${r.leadName || '(unknown)'}`); continue; }
    try {
      const current = await _deps.getSheetRowStatus(sheetUrl, url, linkedinColumn);
      if (!shouldWriteReply(current, r)) { skipped++; continue; }
      const tsIso = new Date(r.timestamp || Date.now()).toISOString();
      await _deps.appendReplyRow(sheetUrl, {
        leadUrl: url, timestamp: tsIso, direction: 'in', sender: r.leadName || 'lead', body: String(r.snippet || ''),
      });
      await _deps.updateSheetRow(sheetUrl, url, {
        Reply: 'yes', ReplyAt: tsIso, ReplyPreview: String(r.snippet || '').slice(0, 100), stage: 'Replied',
      }, linkedinColumn);
      wrote++;
    } catch (e) {
      errors.push(`write-back failed for ${url}: ${e.message}`);
    }
  }
  return { wrote, skipped, errors };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/inbox-sweep.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/linkedin/inbox-sweep.js tests/inbox-sweep.test.js
git commit -m "inbox-sweep: sweep status model + dry-run-gated write-back"
```

---

## Task 6: Inbox sweep orchestration (one profile, preview-only)

**Files:**
- Modify: `src/linkedin/inbox-sweep.js`
- Test: `tests/inbox-sweep.test.js`

**Interfaces:**
- Consumes: `_deps.getConversationsPage`, `classifyConversations`.
- Produces:
  - `loadInboxConversations(page, { watermark, log }) → { convs, error }` — navigates `/messaging/`, nudges + waits ≤20s for the `messengerConversations` XHR, fetches page 1 via `_deps.getConversationsPage`, paginates only if needed, filters to `lastActivityAt > watermark`. Returns `{ convs: [], error: '...' }` on failure (never throws).
  - `sweepProfileInbox({ page, sheetUrl, linkedinColumn, candidateRows, watermark, log }) → { campaignReplies, unmatched, conversationsScanned, error }` — `loadInboxConversations` then `classifyConversations`. Preview-only (no write-back). Per-profile isolated (returns `error` string, never throws).

- [ ] **Step 1: Write the failing test**

Append to `tests/inbox-sweep.test.js` (drives the classification path with a fake page + injected `getConversationsPage`, so no real browser is needed):

```js
import { sweepProfileInbox } from '../src/linkedin/inbox-sweep.js';

function fakePage() {
  // Minimal puppeteer-page stand-in: goto/evaluate/waitForFunction are no-ops.
  return {
    async goto() {}, async evaluate() {}, async waitForFunction() {},
  };
}

test('sweepProfileInbox: classifies fetched conversations, preview-only', async () => {
  _setDeps({
    async getConversationsPage() {
      return { elements: [
        { threadId: 't1', lastActivityAt: 100,
          participants: [{ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' }],
          lastMessage: { text: 'thanks!', deliveredAt: 99, actor: { firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe' } } },
      ], metadata: null };
    },
  });
  const rows = [{ 'First Name': 'Jane', 'Last Name': 'Doe', 'Linkedin URL': 'https://www.linkedin.com/in/jane-doe' }];
  const out = await sweepProfileInbox({ page: fakePage(), sheetUrl: 'S', linkedinColumn: 'Linkedin URL', candidateRows: rows, watermark: 0, log: () => {} });
  assert.equal(out.error, '');
  assert.equal(out.campaignReplies.length, 1);
  assert.equal(out.unmatched.length, 0);
  assert.equal(out.conversationsScanned, 1);
  _setDeps(null);
});

test('sweepProfileInbox: getConversationsPage null → clean error, no throw', async () => {
  _setDeps({ async getConversationsPage() { return null; } });
  const out = await sweepProfileInbox({ page: fakePage(), sheetUrl: 'S', linkedinColumn: 'Linkedin URL', candidateRows: [], watermark: 0, log: () => {} });
  assert.match(out.error, /inbox/i);
  assert.equal(out.campaignReplies.length, 0);
  _setDeps(null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/inbox-sweep.test.js`
Expected: FAIL — `sweepProfileInbox is not a function`.

- [ ] **Step 3: Implement the orchestration**

Append to `src/linkedin/inbox-sweep.js`. The nav/XHR-wait sequence is intentionally duplicated (not imported) from `check-dms.js` so this preview-only path stays independent of the fragile, off-limits scheduler file:

```js
/** Navigate /messaging/, wait for the conversations XHR, fetch + paginate, filter by watermark. */
export async function loadInboxConversations(page, { watermark = 0, log = () => {} } = {}) {
  try {
    if (typeof page.goto === 'function') {
      try {
        await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        return { convs: [], error: `couldn't open inbox: ${e.message}` };
      }
      if (typeof page.waitForFunction === 'function') {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          await page.evaluate(() => {
            const list = document.querySelector('.msg-conversations-container__conversations-list, ul[class*="conversations-list"], .scaffold-layout__list-detail, .scaffold-layout__list');
            if (list) { list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll', { bubbles: true })); }
            window.scrollTo(0, document.body.scrollHeight);
          });
        } catch { /* best-effort nudge */ }
        try {
          await page.waitForFunction(
            () => performance.getEntriesByType('resource').some((e) => typeof e.name === 'string' && e.name.includes('queryId=messengerConversations')),
            { timeout: 20000 },
          );
        } catch { /* fall through — getConversationsPage will return null */ }
      }
    }

    let first;
    try { first = await _deps.getConversationsPage(page, { start: 0, count: 20 }); }
    catch (e) { return { convs: [], error: `couldn't read inbox: ${e.message}` }; }
    if (first === null || first === undefined) {
      return { convs: [], error: "couldn't load inbox for this account (rate-limited or session expired) — try again" };
    }

    const convs = (first.elements || []).filter((el) => (el.lastActivityAt || 0) > watermark);
    const firstOldest = (first.elements || []).reduce((min, e) => Math.min(min, e.lastActivityAt || 0), Number.POSITIVE_INFINITY);
    const paging = first.paging;
    const maybeMore = firstOldest > watermark && (!paging || !paging.total || 20 < paging.total);
    if (maybeMore && (first.elements || []).length >= 20) {
      let start = 20;
      for (let pages = 0; pages < 9; pages++) {
        let batch;
        try { batch = await _deps.getConversationsPage(page, { start, count: 20 }); }
        catch { break; }
        if (!batch || !Array.isArray(batch.elements) || batch.elements.length === 0) break;
        for (const el of batch.elements) { if ((el.lastActivityAt || 0) > watermark) convs.push(el); }
        const oldest = batch.elements.reduce((min, e) => Math.min(min, e.lastActivityAt || 0), Number.POSITIVE_INFINITY);
        if (oldest <= watermark) break;
        start += 20;
      }
    }
    return { convs, error: '' };
  } catch (e) {
    return { convs: [], error: `inbox scan failed: ${e.message}` };
  }
}

/** Preview-only sweep for one profile. Never throws — per-profile isolated. */
export async function sweepProfileInbox({ page, sheetUrl, linkedinColumn, candidateRows, watermark = 0, log = () => {} }) {
  const { convs, error } = await loadInboxConversations(page, { watermark, log });
  if (error) return { campaignReplies: [], unmatched: [], conversationsScanned: 0, error };
  const { campaignReplies, unmatched } = classifyConversations(convs, candidateRows, linkedinColumn);
  return { campaignReplies, unmatched, conversationsScanned: convs.length, error: '' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/inbox-sweep.test.js`
Expected: PASS (all inbox-sweep tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `node --test`
Expected: PASS — prior count (1061) + the new inbox-sweep tests, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/linkedin/inbox-sweep.js tests/inbox-sweep.test.js
git commit -m "inbox-sweep: preview-only per-profile sweep orchestration"
```

---

## Task 7: Server controller — /api/reply-sweep/start|status|stop

**Files:**
- Modify: `server.js` (add import near `check-dms.js` import at `server.js:41`; add state + endpoints near the FG team-launch block at `server.js:1536-1642`)

**Interfaces:**
- Consumes: `sweepProfileInbox`, `applyReplyWriteBack`, `makeInitialSweepStatus` (Tasks 5–6); existing `fetchSheet`, `getProfiles`, `launchProfile`, `launchLocalBrowser`, `closeProfile`, `closeLocalBrowser`, `getProfilePid`, `setBulkCheckInProgress`, `preventSleep`, `allowSleep`, `campaignLog`, `CHECK_DMS_STAGE_FILTER`.
- Produces: HTTP endpoints — `GET /api/reply-sweep/status` (returns the live status object), `POST /api/reply-sweep/start` (body `{ sheetUrl, linkedinColumn?, profileIds?, dryRun? }`; `dryRun` defaults `true`), `POST /api/reply-sweep/stop`.

- [ ] **Step 1: Add the import**

In `server.js`, directly under the existing line 41 (`import { checkProfileDms, checkProfileDmsPerLead } from './src/linkedin/check-dms.js';`) add:

```js
import { sweepProfileInbox, applyReplyWriteBack, makeInitialSweepStatus } from './src/linkedin/inbox-sweep.js';
```

- [ ] **Step 2: Add module state + endpoints**

In `server.js`, immediately AFTER the FG team-launch start endpoint closes (the `});` at `server.js:1642`), insert:

```js
// ── Manual bulk reply sweep ──────────────────────────────────────────────────
// One-button, observable inbox sweep. Mirrors the FG team-launch streaming
// pattern: sequential per-profile scan, isolated per-profile errors, force-close
// on stop. Preview-only unless the operator turns dry-run OFF.
let _replySweep = makeInitialSweepStatus([], true);
_replySweep.running = false; _replySweep.phase = 'idle';
let _replySweepAbort = false;
let _replySweepHandle = null;

app.get('/api/reply-sweep/status', (_req, res) => res.json(_replySweep));

app.post('/api/reply-sweep/stop', async (_req, res) => {
  _replySweepAbort = true;
  const h = _replySweepHandle; _replySweepHandle = null;
  try { if (h && typeof h.close === 'function') await h.close(); } catch (_) {}
  res.json({ ok: true });
});

app.post('/api/reply-sweep/start', async (req, res) => {
  if (_replySweep.running) return res.status(409).json({ error: 'A reply sweep is already running.' });
  const b = req.body || {};
  let { sheetUrl, linkedinColumn, profileIds } = b;
  const dryRun = b.dryRun !== false; // default ON (preview-only) unless explicitly false
  if (!sheetUrl && campaign.running && campaign.sheetUrl) {
    sheetUrl = campaign.sheetUrl;
    linkedinColumn = linkedinColumn || campaign.linkedinColumn || '';
  }
  if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
  linkedinColumn = linkedinColumn || 'Linkedin URL';

  // Load + group sent rows by sender (same grouping as /api/reply-check-now).
  const token = process.env.GOLOGIN_API_TOKEN;
  let rows;
  try { rows = await fetchSheet(sheetUrl); }
  catch (err) { return res.status(400).json({ error: `Could not load sheet: ${err.message}` }); }

  let nameByProfileId = new Map();
  let nameToId = {};
  try {
    const allProfiles = await getProfiles(token);
    nameByProfileId = new Map(allProfiles.map((p) => [p.id, p.name || p.id]));
    for (const p of allProfiles) nameToId[(p.name || '').toLowerCase()] = p.id;
  } catch { /* fall back to id-as-name */ }

  const hasStageSchema = rows.length > 0 && ('Stage' in rows[0]);
  const candidateRows = rows.filter((row) =>
    hasStageSchema ? CHECK_DMS_STAGE_FILTER.has(String(row.Stage || '').trim())
                   : String(row.Message || '').trim().toLowerCase() === 'sent');

  const wanted = Array.isArray(profileIds) && profileIds.length ? profileIds.slice() : null;
  const leadsByProfile = new Map();
  for (const row of candidateRows) {
    const acct = String(row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').trim();
    if (!acct) continue;
    const pid = nameToId[acct.toLowerCase()] || acct;
    if (wanted && !wanted.includes(pid)) continue;
    if (!leadsByProfile.has(pid)) leadsByProfile.set(pid, []);
    leadsByProfile.get(pid).push(row);
  }

  const pids = [...leadsByProfile.keys()];
  const names = pids.map((pid) => nameByProfileId.get(pid) || pid);
  res.json({ started: true, profiles: names.length });

  _replySweep = makeInitialSweepStatus(names, dryRun);
  _replySweepAbort = false;

  // Scan window: campaign first send-out − 12h, else 14 days back.
  const startMs = campaign.startedAt ? Date.parse(campaign.startedAt) : NaN;
  const watermark = (Number.isFinite(startMs) ? startMs : (Date.now() - 14 * 86400000)) - 12 * 60 * 60 * 1000;
  const stamp = (m) => { _replySweep.logs.push(`[${new Date().toISOString()}] ${m}`); if (_replySweep.logs.length > 200) _replySweep.logs.shift(); try { campaignLog(`[reply-sweep] ${m}`); } catch (_) {} };

  (async () => {
    setBulkCheckInProgress(true);
    preventSleep('reply-sweep');
    try {
      stamp(`▶ Reply sweep started · ${pids.length} account(s) · ${dryRun ? 'preview only' : 'WRITE-BACK ON'}`);
      for (let i = 0; i < pids.length; i++) {
        const pid = pids[i];
        const slot = _replySweep.perProfile[i];
        const pName = names[i];
        if (_replySweepAbort) { slot.status = 'skipped'; slot.error = 'stopped'; stamp(`⊘ [${pName}] Stopped`); continue; }
        _replySweep.currentProfile = pName;
        slot.status = 'running';
        const wasRunning = !!getProfilePid(pid);
        const isLocal = pid === 'local-browser';
        let launched = null, handle = null;
        try {
          stamp(`📬 [${pName}] Scanning inbox…`);
          launched = isLocal ? await launchLocalBrowser() : await launchProfile(pid, token);
          handle = { close: async () => { try { await (isLocal ? closeLocalBrowser() : closeProfile(pid)); } catch (_) {} } };
          _replySweepHandle = handle;

          const out = await sweepProfileInbox({
            page: launched.page, sheetUrl, linkedinColumn,
            candidateRows: leadsByProfile.get(pid), watermark, log: stamp,
          });
          if (out.error) { slot.status = 'error'; slot.error = out.error; stamp(`⚠ [${pName}] ${out.error}`); }
          else {
            slot.replies = out.campaignReplies.length;
            slot.unmatched = out.unmatched.length;
            slot.status = 'done';
            for (const r of out.campaignReplies) _replySweep.campaignReplies.push({ ...r, account: pName });
            for (const u of out.unmatched) _replySweep.unmatched.push({ ...u, account: pName });
            stamp(`📬 [${pName}] ${out.campaignReplies.length} reply(ies), ${out.unmatched.length} unmatched · ${out.conversationsScanned} scanned`);

            if (!dryRun && out.campaignReplies.length) {
              const wb = await applyReplyWriteBack({ sheetUrl, linkedinColumn, campaignReplies: out.campaignReplies });
              _replySweep.wrote += wb.wrote;
              stamp(`✍ [${pName}] wrote ${wb.wrote}, skipped ${wb.skipped}${wb.errors.length ? `, ${wb.errors.length} error(s)` : ''}`);
            }
          }
        } catch (err) {
          if (_replySweepAbort) { slot.status = 'skipped'; slot.error = 'stopped'; stamp(`⊘ [${pName}] Stopped`); }
          else { slot.status = 'error'; slot.error = err.message; stamp(`✗ [${pName}] ${err.message}`); }
        } finally {
          _replySweepHandle = null;
          if (!wasRunning && handle) { try { await handle.close(); } catch (_) {} }
          _replySweep.doneProfiles++;
        }
      }
      _replySweep.phase = 'done';
      stamp(`■ Reply sweep complete — ${_replySweep.campaignReplies.length} reply(ies), ${_replySweep.unmatched.length} unmatched${dryRun ? '' : `, ${_replySweep.wrote} written`}`);
    } catch (err) {
      _replySweep.phase = 'error'; _replySweep.error = err.message; stamp(`✗ Fatal — ${err.message}`);
    } finally {
      _replySweep.running = false; _replySweep.currentProfile = null;
      setBulkCheckInProgress(false);
      try { allowSleep(); } catch (_) {}
    }
  })();
});
```

- [ ] **Step 3: Verify the server boots**

Run: `node --check server.js && echo "syntax OK"`
Expected: `syntax OK`.

Run: `node -e "import('./src/linkedin/inbox-sweep.js').then(m => { for (const f of ['sweepProfileInbox','applyReplyWriteBack','makeInitialSweepStatus']) if (typeof m[f] !== 'function') throw new Error('missing '+f); console.log('exports OK'); })"`
Expected: `exports OK`.

- [ ] **Step 4: Manual smoke test (documented; no UI test framework)**

Bump version, relaunch, and exercise the endpoint with the app's own sheet:

```bash
node -e "const p=require('./package.json');p.version=p.version.replace(/(\d+)$/,m=>+m+1);require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');console.log('v'+p.version)"
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; sleep 1; npm run dev:app > /tmp/dev-app.log 2>&1 &
```

Then in a second shell: `curl -s localhost:7847/api/reply-sweep/status` → expect JSON with `"running":false,"phase":"idle"`. Confirm `POST /api/reply-sweep/start` with no `sheetUrl` (and no running campaign) returns `400 sheetUrl required`. Full live-account verification happens in Task 8 via the UI.

- [ ] **Step 5: Commit**

```bash
git add server.js package.json
git commit -m "reply-sweep: server controller (start/status/stop, dry-run gated write-back)"
```

---

## Task 8: Check DMs mode = A3 split view (entry point + UI)

The feature is reached by selecting the **Check DMs** campaign type, which opens the
A3 split view as a self-contained mode (the Follower Growth pattern). Reference sketch:
`public/sketches/2026-06-25-reply-check-A3-page.html` (the live A3 layout) and
`public/sketches/2026-06-25-reply-check-flow.html` (the dashboard→A3 flow).

**Files:**
- Modify: `public/js/app.js` (`MODE_LIST` re-enable; `onModeChange` reveal branch; A3 controller)
- Modify: `public/index.html` (A3 split markup + CSS, keyed to `mode === 'check_dms'`)

**Interfaces:**
- Consumes: `/api/reply-sweep/start|status|stop` (Task 7); the existing `onModeChange`
  self-contained-mode pattern used by `follower_growth` / `sales_nav_scrape`.
- Produces: the A3 view shown only when `mode === 'check_dms'`. Poll loop reuses the
  `fgtlPoll` pattern (700ms `setInterval`, re-render from status, stop shown while running).

- [ ] **Step 1: Re-enable the Check DMs mode card**

In `public/js/app.js`, in the `MODE_LIST` entry for `check_dms` (the one with
`disabledReason: 'Check DMs is unavailable.'`), remove the `disabled: true` and
`disabledReason` lines so the card is selectable again. Keep its existing bullets
(they already describe this feature). Optionally update `name: 'Check DMs'` copy is
left as-is unless the operator asks to rename it to "Reply check".

Run: `node --check public/js/app.js && echo "syntax OK"` → Expected: `syntax OK`.

- [ ] **Step 2: Reveal the A3 panel on mode change**

In `onModeChange` (around `public/js/app.js:2008`, the `isCheckDms` branch), follow the
Follower-Growth self-contained-mode pattern: when `mode === 'check_dms'`, hide the
normal campaign sections (Data / Accounts / Settings / Launch / Live Status) and show
`#reply-sweep-panel`; otherwise hide the panel. Mirror exactly how the
`follower_growth` branch toggles `#nav-follower-growth` so behavior is consistent.

- [ ] **Step 3: Add the A3 split markup**

In `public/index.html`, add the self-contained Check DMs section (hidden by default;
`onModeChange` reveals it). Implements the A3 sketch — toolbar + left reply list +
right read pane:

```html
<!-- Check DMs mode — A3 reply-check split view. Shown only when mode === 'check_dms'. -->
<div class="section" id="reply-sweep-panel" style="display:none">
  <div class="rsweep-toolbar">
    <span class="rsweep-eyebrow" id="rsweep-eyebrow" style="display:none"></span>
    <span class="rsweep-spacer"></span>
    <label class="alpha-toggle rsweep-dry" title="When on, the sweep only previews replies — it never writes to the sheet.">
      <input type="checkbox" id="rsweep-dryrun" checked />
      <span class="alpha-toggle-track"></span>
    </label>
    <span class="rsweep-dry-label">Preview only — don't write to the sheet</span>
    <button class="btn-primary" id="rsweep-run">Check replies now</button>
    <button class="rsweep-stop" id="rsweep-stop" style="display:none">Stop now</button>
  </div>
  <div class="rsweep-log" id="rsweep-log"></div>
  <div class="rsweep-split">
    <div class="rsweep-list" id="rsweep-list"><!-- grouped Campaign replies / Unmatched, rendered by JS --></div>
    <div class="rsweep-pane" id="rsweep-pane"><div class="rsweep-empty">Run a check, then pick a reply to read it here.</div></div>
  </div>
</div>
```

Add CSS implementing the A3 sketch verbatim (`.rsweep-split` = `grid-template-columns: 340px 1fr` with a hairline divider; `.rsweep-list` scrollable group list; selected row gets `box-shadow: inset 2px 0 0 var(--gold)`; `.rsweep-pane` read view with `.rsweep-bubble`; gold-only CTA via the existing `.btn-primary`; `.rsweep-suspect` tag; empty states). Copy the class names/values from `2026-06-25-reply-check-A3-page.html` so the live view is 1:1 with the sketch.

- [ ] **Step 4: Add the A3 controller in app.js**

In `public/js/app.js`, add (near the other mode controllers; expose `window.rsweep*` like `window.fgtl*`). Renders the grouped left list + selects a reply into the right read pane:

```js
// ── Check DMs / reply-check (A3 split) controller ────────────────────────────
let _rsweepTimer = null;
let _rsweepSel = null;     // threadId of the reply shown in the read pane
let _rsweepLast = null;    // last status, so list clicks can re-render the pane

function rsweepEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Flat, ordered list of every reply (campaign first, then unmatched) for selection.
function rsweepAll(s) {
  return [...(s.campaignReplies || []).map((r) => ({ ...r, group: 'campaign' })),
          ...(s.unmatched || []).map((r) => ({ ...r, group: 'unmatched' }))];
}

function rsweepListItem(r) {
  const tag = r.suspected ? `<span class="rsweep-suspect">same-name</span>` : '';
  const sel = r.threadId && r.threadId === _rsweepSel ? ' sel' : '';
  return `<div class="rsweep-item${sel}" data-tid="${rsweepEsc(r.threadId)}">
    <div class="rsweep-item-nm">${rsweepEsc(r.leadName)}${tag}</div>
    <div class="rsweep-item-snip">${rsweepEsc(r.snippet)}</div></div>`;
}

function rsweepPane(r) {
  if (!r) return `<div class="rsweep-empty">Run a check, then pick a reply to read it here.</div>`;
  const when = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';
  const url = r.linkedinUrl || r.profileUrl || '';
  return `<div class="rsweep-pane-head"><div class="rsweep-pane-nm">${rsweepEsc(r.leadName)}</div>
      <div class="rsweep-pane-meta">${rsweepEsc(r.account || '')} · ${rsweepEsc(when)}</div></div>
    <div class="rsweep-bubble">${rsweepEsc(r.snippet)}</div>
    ${url ? `<a class="rsweep-chip" href="${rsweepEsc(url)}" target="_blank" rel="noopener">↗ open thread in linkedin</a>` : ''}`;
}

function rsweepRender(s) {
  _rsweepLast = s;
  const eyebrow = document.getElementById('rsweep-eyebrow');
  const runBtn = document.getElementById('rsweep-run');
  const stopBtn = document.getElementById('rsweep-stop');
  const log = document.getElementById('rsweep-log');
  if (!eyebrow) return;
  if (s.running) {
    eyebrow.style.display = '';
    eyebrow.textContent = `Scanning ${rsweepEsc(s.currentProfile || '…')} · ${s.doneProfiles}/${s.totalProfiles} accounts`;
    runBtn.disabled = true; stopBtn.style.display = '';
  } else {
    eyebrow.style.display = (s.phase === 'done' || s.phase === 'error') ? '' : 'none';
    if (s.phase === 'done') eyebrow.textContent = `Done · ${s.campaignReplies.length} reply(ies), ${s.unmatched.length} unmatched${s.dryRun ? '' : ` · ${s.wrote} written`}`;
    if (s.phase === 'error') eyebrow.textContent = `Error — ${rsweepEsc(s.error || '')}`;
    runBtn.disabled = false; stopBtn.style.display = 'none';
  }
  if (log) log.textContent = s.logs && s.logs.length ? s.logs[s.logs.length - 1] : '';

  const all = rsweepAll(s);
  if (!_rsweepSel && all.length) _rsweepSel = all[0].threadId; // auto-select first
  const camp = s.campaignReplies || [], unm = s.unmatched || [];
  const list = document.getElementById('rsweep-list');
  list.innerHTML =
    `<div class="rsweep-grp">Campaign replies · ${camp.length}</div>` +
    (camp.length ? camp.map(rsweepListItem).join('') : `<div class="rsweep-empty">None</div>`) +
    `<div class="rsweep-grp">Unmatched · ${unm.length}</div>` +
    (unm.length ? unm.map(rsweepListItem).join('') : `<div class="rsweep-empty">None</div>`);
  document.getElementById('rsweep-pane').innerHTML = rsweepPane(all.find((r) => r.threadId === _rsweepSel) || all[0] || null);
}

async function rsweepPoll() {
  try {
    const s = await fetch('/api/reply-sweep/status').then((r) => r.json());
    rsweepRender(s);
    if (!s.running && _rsweepTimer) { clearInterval(_rsweepTimer); _rsweepTimer = null; }
  } catch (_) { /* transient */ }
}

async function rsweepStart() {
  const dryRun = document.getElementById('rsweep-dryrun')?.checked !== false;
  const sheetUrl = document.getElementById('sheet-url')?.value?.trim() || '';
  const linkedinColumn = document.getElementById('linkedin-column')?.value?.trim() || '';
  try {
    const resp = await fetch('/api/reply-sweep/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetUrl, linkedinColumn, dryRun }),
    });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); showCampaignToast(e.error || 'Could not start reply sweep', 3500); return; }
    if (_rsweepTimer) clearInterval(_rsweepTimer);
    _rsweepTimer = setInterval(rsweepPoll, 700);
    rsweepPoll();
  } catch (e) { showCampaignToast(`Reply sweep failed: ${e.message}`, 3500); }
}

async function rsweepStop() { try { await fetch('/api/reply-sweep/stop', { method: 'POST' }); } catch (_) {} }

function rsweepBind() {
  const run = document.getElementById('rsweep-run');
  const stop = document.getElementById('rsweep-stop');
  const list = document.getElementById('rsweep-list');
  if (run) run.addEventListener('click', rsweepStart);
  if (stop) stop.addEventListener('click', rsweepStop);
  if (list) list.addEventListener('click', (e) => {           // pick a reply → read pane
    const item = e.target.closest('.rsweep-item');
    if (!item || !_rsweepLast) return;
    _rsweepSel = item.getAttribute('data-tid');
    rsweepRender(_rsweepLast);
  });
  rsweepPoll(); // reflect an in-flight sweep on load
}
document.addEventListener('DOMContentLoaded', rsweepBind);
if (document.readyState !== 'loading') rsweepBind();
window.rsweepStart = rsweepStart;
window.rsweepStop = rsweepStop;
```

Note: confirm the sheet-URL + linkedin-column input element IDs (`sheet-url`, `linkedin-column`) match the live form before relying on them; if they differ, use the actual IDs. (Grep `public/index.html` for the sheet URL input.)

- [ ] **Step 5: Bump version + relaunch**

```bash
node -e "const p=require('./package.json');p.version=p.version.replace(/(\d+)$/,m=>+m+1);require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');console.log('v'+p.version)"
node --check public/js/app.js && echo "syntax OK"
pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*ortus" 2>/dev/null; sleep 1; npm run dev:app > /tmp/dev-app.log 2>&1 &
```

- [ ] **Step 6: Manual verification**

Reload the app (Cmd+R). Confirm: (a) selecting the **Check DMs** campaign type opens the A3 split view (no longer greyed) and hides the normal campaign sections; (b) the dry-run toggle is checked by default; (c) "Check replies now" streams progress in the eyebrow + log line, then fills the left list (grouped campaign / unmatched) and auto-selects the first reply into the read pane; (d) clicking a name swaps the read pane; (e) in dry-run nothing is written to the sheet (verify the sheet is untouched); (f) turning dry-run off and re-running appends to the Replies tab + bumps Stage to "Replied" only for matched campaign replies; (g) "Stop now" halts mid-run; (h) switching to another campaign type hides the panel and restores the normal sections. Use `claude-in-chrome` to screenshot the populated view and read console for errors.

- [ ] **Step 7: Run the full suite**

Run: `node --test`
Expected: PASS, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/js/app.js package.json
git commit -m "check-dms mode: A3 reply-check split view (entry point + UI, dry-run default ON)"
```

---

## Self-Review

**1. Spec coverage:**
- Manual one-button sweep, visible/streaming → Tasks 7–8 (status streaming, eyebrow + log). ✓
- Entry = re-enabled **Check DMs** campaign type; selecting it always opens the A3 split view (self-contained mode, no drawer/dashboard card) → Task 8 Steps 1–3. ✓
- Cheap path reuse (`getConversationsPage` + `fetchNewConversations`) → Task 6 `loadInboxConversations`. ✓
- Scope = campaign replies + unmatched section → Task 4 `classifyConversations`, Task 8 two sections. ✓
- Matching identity-first, name fallback, skip-on-doubt → Task 3 `matchConversationIdentitySafe`. ✓
- Preview-only drill-in, zero extra tab opens → Task 6 sweep is preview-only; no compose/thread navigation. ✓
- Write-back dry-run default ON → Task 5 gate + Task 7 `dryRun !== false` + Task 8 toggle `checked`. ✓
- Scheduler untouched, no send/compose changes → new files only; constraint stated. ✓
- Per-profile error isolation → Task 6 returns `error`, Task 7 try/catch per profile. ✓
- Visually good + intuitive (user requirement) → Task 1 sketch + Task 8 implements it with explicit acceptance criteria. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — each code step shows complete code. The one soft spot (front-end input IDs) is flagged with an explicit verification instruction, not left vague. ✓

**3. Type consistency:** `Reply` preview shape (`leadName/snippet/profileUrl/threadId/timestamp/linkedinUrl/row/suspected`) is produced in Task 4 `previewOf` and consumed unchanged by Task 5 `applyReplyWriteBack` (`linkedinUrl/snippet/timestamp/leadName`), Task 7 (spreads + `account`), and Task 8 `rsweepRow`. Status shape from `makeInitialSweepStatus` (Task 5) is the same object mutated in Task 7 and read in Task 8. `_setDeps`/`_deps` mirror check-dms.js. ✓
