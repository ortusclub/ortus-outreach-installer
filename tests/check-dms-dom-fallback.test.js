/**
 * Phase 11.3 Wave 0 — RED test for DOM fallback parser.
 *
 * parseInboxDom(html) takes the raw inbox HTML and returns structured
 * conversations. Will fail until Plan 11.3-02 creates src/linkedin/check-dms.js.
 *
 * If tests/fixtures/inbox-dom-page1.html has not been captured yet, the
 * fixture-dependent test will be marked "todo" so RED state still captures
 * the missing-module signal from the other assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseInboxDom } from '../src/linkedin/check-dms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures/inbox-dom-page1.html');

let fixture = null;
try {
  fixture = await readFile(FIXTURE_PATH, 'utf-8');
} catch { /* fixture not captured yet — dependent tests skip */ }

test('parseInboxDom: handles empty HTML gracefully', () => {
  const result = parseInboxDom('');
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

test('parseInboxDom: handles HTML with no msg-conversation-listitem elements', () => {
  const result = parseInboxDom('<div><p>empty inbox</p></div>');
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

test('parseInboxDom: minimal stub — 1 conversation with known structure', () => {
  // Minimal synthetic HTML that should parse regardless of LinkedIn's exact classes.
  // Plan 11.3-02 must make parseInboxDom flexible enough to extract:
  // - participant name
  // - snippet
  // - threadId (from href)
  const html = `
    <ul>
      <li class="msg-conversation-listitem">
        <a href="/messaging/thread/2-test-thread-id/" class="msg-conversation-card__link">
          <div class="msg-conversation-card__participant-names">Redacted One Alpha</div>
          <span class="msg-conversation-card__message-snippet">Hello there</span>
          <time class="msg-conversation-card__time-stamp" datetime="2026-04-23T08:00:00.000Z">2h</time>
        </a>
      </li>
    </ul>
  `;
  const result = parseInboxDom(html);
  assert.equal(result.length, 1, 'should extract 1 conversation');
  assert.equal(result[0].threadId, '2-test-thread-id');
  assert.match(result[0].participant?.firstName ?? '', /redacted/i);
  assert.match(result[0].snippet ?? '', /hello/i);
});

test('parseInboxDom: live fixture produces non-empty result', { skip: !fixture }, () => {
  const result = parseInboxDom(fixture);
  assert.ok(Array.isArray(result));
  assert.ok(result.length > 0, 'captured fixture should have at least one conversation');
  for (const conv of result) {
    assert.ok(conv.threadId, 'every conv should have a threadId');
    assert.ok(conv.participant?.firstName || conv.participant?.lastName, 'every conv should have a participant name');
  }
});
