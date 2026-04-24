/**
 * Phase 11.3 Wave 0 — RED test for pagination stop condition.
 *
 * Per 11.3-RESEARCH.md Finding 3: once a page contains only messages older
 * than the watermark, we can stop paginating (results sorted by
 * lastActivityAt DESC).
 *
 * Will fail with ERR_MODULE_NOT_FOUND until Plan 11.3-02 creates
 * src/linkedin/check-dms.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchNewConversations } from '../src/linkedin/check-dms.js';

// Helper — synthesize a page of N conversations, each separated by 1 hour.
// Timestamps decrease monotonically across ALL pages (not just within a page)
// so pagination's "stop when oldest <= watermark" is testable end-to-end.
function synthPage({ start, count, total, baseTs, decreasing = true }) {
  const elements = [];
  for (let i = 0; i < count; i++) {
    const globalIndex = start + i;
    const offset = decreasing ? globalIndex : -globalIndex;
    elements.push({
      entityUrn: `urn:li:fs_conversation:${globalIndex}`,
      lastActivityAt: baseTs - offset * 3600 * 1000,
      participants: [{ miniProfile: { firstName: `Test${globalIndex}`, lastName: 'Person' } }],
      events: [{ createdAt: baseTs - offset * 3600 * 1000, eventContent: { body: { text: `msg ${globalIndex}` } } }],
    });
  }
  return { elements, paging: { count, start, total } };
}

test('fetchNewConversations: returns only messages newer than watermark', async () => {
  const now = Date.now();
  const watermark = now - 5 * 3600 * 1000; // 5 hours ago
  const pageFactory = async ({ start, count }) => {
    // Page 1: 10 convs, newest to oldest, spanning 0h–9h
    return synthPage({ start: 0, count: 10, total: 10, baseTs: now });
  };
  const result = await fetchNewConversations(pageFactory, watermark);
  assert.ok(result.every(c => c.lastActivityAt > watermark), 'all results newer than watermark');
  // 0h, 1h, 2h, 3h, 4h → 5 convs strictly newer than 5h ago
  assert.equal(result.length, 5);
});

test('fetchNewConversations: stops paginating when batch has all-old messages', async () => {
  const now = Date.now();
  const watermark = now - 30 * 3600 * 1000; // 30 hours ago
  let pagesFetched = 0;
  const pageFactory = async ({ start, count }) => {
    pagesFetched++;
    // Page 1 (start=0): 0h–19h (all newer than 30h)
    if (start === 0) return synthPage({ start: 0, count: 20, total: 60, baseTs: now });
    // Page 2 (start=20): 20h–39h (mix)
    if (start === 20) return synthPage({ start: 20, count: 20, total: 60, baseTs: now });
    // Page 3 (start=40): 40h+ all older — MUST NOT BE FETCHED because page 2 had old items
    return synthPage({ start: 40, count: 20, total: 60, baseTs: now });
  };
  const result = await fetchNewConversations(pageFactory, watermark);
  assert.equal(pagesFetched, 2, 'should short-circuit after page 2 contains old items');
  assert.ok(result.every(c => c.lastActivityAt > watermark));
});

test('fetchNewConversations: first-ever run (watermark=0) returns all', async () => {
  const now = Date.now();
  const watermark = 0;
  const pageFactory = async ({ start }) => {
    if (start === 0) return synthPage({ start: 0, count: 20, total: 20, baseTs: now });
    return { elements: [], paging: { count: 20, start, total: 20 } };
  };
  const result = await fetchNewConversations(pageFactory, watermark);
  assert.equal(result.length, 20);
});

test('fetchNewConversations: empty inbox returns empty array', async () => {
  const pageFactory = async () => ({ elements: [], paging: { count: 20, start: 0, total: 0 } });
  const result = await fetchNewConversations(pageFactory, 0);
  assert.deepEqual(result, []);
});
