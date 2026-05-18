/**
 * Phase 11.3 Wave 0 — RED test for the checkProfileDms orchestrator.
 *
 * End-to-end mock test: stubs getConversationsPage + updateSheetRow +
 * getSheetRowStatus, asserts the orchestrator wires them together correctly
 * for the expected flow.
 *
 * Will fail with ERR_MODULE_NOT_FOUND until Plan 11.3-02 creates
 * src/linkedin/check-dms.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { checkProfileDms, _setDeps } from '../src/linkedin/check-dms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHEET_ROWS = JSON.parse(
  await readFile(join(__dirname, 'fixtures/sheet-rows.json'), 'utf-8')
);

function mockPage() { return { mock: true }; }

function mockDeps({ conversationsPages = [], rowStatuses = {}, sheetUpdates = [] } = {}) {
  const stubs = {
    getConversationsPage: async () => conversationsPages.shift() ?? null,
    getSheetRowStatus: async (_url, linkedinUrl) => rowStatuses[linkedinUrl] ?? null,
    updateSheetRow: async (_url, linkedinUrl, tracking) => { sheetUpdates.push({ linkedinUrl, tracking }); },
    // appendReplyRow must be stubbed — the orchestrator calls it unconditionally
    // before updateSheetRow. Pre-v2.52.0 the real impl silently no-op'd when
    // SHEETS_WEBAPP_URL was empty in the test env; v2.52.0 hard-codes the URL,
    // so the real impl would attempt a real fetch and trigger the orchestrator's
    // try/catch, masking updateSheetRow.
    appendReplyRow: async () => {},
    ensureOpen: async () => ({ page: mockPage(), profileId: 'Antonio', pName: 'Antonio' }),
    closeSession: async () => {},
    // Orchestrator reads candidate rows from an injected function too:
    getCandidateRows: async () => SHEET_ROWS.filter(r => r['Account Used'] === 'Antonio' && r.Message === 'sent'),
  };
  return { stubs, sheetUpdates };
}

test('checkProfileDms: scans conversations and writes matched replies to sheet', async () => {
  const { stubs, sheetUpdates } = mockDeps({
    conversationsPages: [{
      // NORMALIZED shape produced by getConversationsPage (see 11.3-RESEARCH.md Finding 1)
      elements: [
        {
          entityUrn: 'urn:li:msg_conversation:2-abc',
          threadId: '2-abc',
          lastActivityAt: Date.now(),
          unreadCount: 1,
          participants: [{ firstName: 'Gurneet', lastName: 'Jodhka', profileUrl: 'https://www.linkedin.com/in/gurneet' }],
          lastMessage: {
            text: 'Thanks for reaching out',
            deliveredAt: Date.now(),
            actor: { firstName: 'Gurneet', lastName: 'Jodhka', profileUrl: 'https://www.linkedin.com/in/gurneet' },
          },
        },
      ],
      metadata: {},
    }],
  });

  _setDeps(stubs);
  try {
    const result = await checkProfileDms('Antonio', {
      watermark: 0,
      sheetUrl: 'https://sheet.example',
      linkedinColumn: 'Linkedin URL',
    });

    assert.equal(result.replies.length, 1);
    assert.equal(result.replies[0].match.firstName, 'Gurneet');
    assert.equal(sheetUpdates.length, 1);
    assert.equal(sheetUpdates[0].tracking.Reply, 'yes');
    assert.match(sheetUpdates[0].tracking.ReplyPreview, /Thanks/);
  } finally {
    _setDeps(null);
  }
});

test('checkProfileDms: skips writeback when row already has Reply=yes', async () => {
  const sheetUpdates = [];
  const { stubs } = mockDeps({
    conversationsPages: [{
      elements: [
        {
          entityUrn: 'urn:li:msg_conversation:2-xyz',
          threadId: '2-xyz',
          lastActivityAt: Date.now(),
          unreadCount: 1,
          participants: [{ firstName: 'Julia', lastName: 'Nguyen', profileUrl: 'https://www.linkedin.com/in/julia' }],
          lastMessage: {
            text: 'New reply',
            deliveredAt: Date.now(),
            actor: { firstName: 'Julia', lastName: 'Nguyen', profileUrl: 'https://www.linkedin.com/in/julia' },
          },
        },
      ],
      metadata: {},
    }],
    rowStatuses: {
      'https://www.linkedin.com/in/ACwAABMElp0BflO-iGMBHAz3Syooy7A5ecJ_JiM': { Reply: 'yes' },
    },
    sheetUpdates,
  });

  _setDeps(stubs);
  try {
    const result = await checkProfileDms('Antonio', {
      watermark: 0,
      sheetUrl: 'https://sheet.example',
      linkedinColumn: 'Linkedin URL',
    });
    assert.equal(sheetUpdates.length, 0, 'should NOT write to sheet when Reply=yes already');
    assert.equal(result.replies.length, 1, 'reply still surfaces in the panel even if sheet not written');
  } finally {
    _setDeps(null);
  }
});

test('checkProfileDms: returns errors + does NOT advance watermark when Voyager returns null', async () => {
  // DOM-scrape fallback deferred per 2026-04-24 revision in 11.3-CONTEXT.md.
  // Voyager null → scan fails, operator retries.
  const { stubs } = mockDeps({ conversationsPages: [null] });

  _setDeps(stubs);
  try {
    const result = await checkProfileDms('Antonio', {
      watermark: 1000,
      sheetUrl: 'https://sheet.example',
      linkedinColumn: 'Linkedin URL',
    });
    assert.equal(result.newWatermark, undefined, 'no new watermark on failure');
    assert.ok(result.errors.length > 0, 'errors array populated');
    assert.deepEqual(result.replies, []);
  } finally {
    _setDeps(null);
  }
});

test('checkProfileDms: advances watermark on success', async () => {
  const { stubs } = mockDeps({
    conversationsPages: [{
      elements: [],
      paging: { count: 20, start: 0, total: 0 },
    }],
  });

  _setDeps(stubs);
  try {
    const before = Date.now();
    const result = await checkProfileDms('Antonio', {
      watermark: 0,
      sheetUrl: 'https://sheet.example',
      linkedinColumn: 'Linkedin URL',
    });
    assert.ok(result.newWatermark >= before, 'watermark advanced to at-least run start time');
    assert.equal(result.errors.length, 0);
  } finally {
    _setDeps(null);
  }
});
