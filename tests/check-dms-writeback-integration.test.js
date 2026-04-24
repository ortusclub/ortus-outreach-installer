/**
 * Phase 11.3-05 Wave 3 — Integration test for the writeback flow.
 *
 * Exercises the REAL exported performWriteBack from src/linkedin/check-dms.js
 * (NOT a re-implementation in the test). If the orchestrator's non-destructive
 * guard drifts (e.g. someone renames a field or reorders calls), this test
 * catches it because it's pointing at the same code path production uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { performWriteBack, _setDeps } from '../src/linkedin/check-dms.js';

test('performWriteBack: skips updateSheetRow when Reply already "yes"', async () => {
  const updateCalls = [];
  _setDeps({
    getSheetRowStatus: async () => ({ Reply: 'yes', ReplyAt: '', ReplyPreview: '' }),
    updateSheetRow: async (...args) => { updateCalls.push(args); return true; },
  });
  try {
    const result = await performWriteBack(
      'https://sheet.example',
      'https://www.linkedin.com/in/ACwAAAxxx',
      { text: 'New reply', deliveredAt: Date.now() },
      'Linkedin URL',
    );
    assert.equal(result.wrote, false);
    assert.equal(result.reason, 'already-replied');
    assert.equal(updateCalls.length, 0, 'updateSheetRow must NOT be called when Reply=yes');
  } finally {
    _setDeps(null);
  }
});

test('performWriteBack: calls updateSheetRow when Reply is empty', async () => {
  const updateCalls = [];
  _setDeps({
    getSheetRowStatus: async () => ({ Reply: '', ReplyAt: '', ReplyPreview: '' }),
    updateSheetRow: async (sheetUrl, linkedinUrl, tracking, linkedinColumn) => {
      updateCalls.push({ sheetUrl, linkedinUrl, tracking, linkedinColumn });
      return true;
    },
  });
  try {
    const ts = Date.now();
    const result = await performWriteBack(
      'https://sheet.example',
      'https://www.linkedin.com/in/ACwAAAxxx',
      { text: 'Hi Antonio, thanks for reaching out!', deliveredAt: ts },
      'Linkedin URL',
    );
    assert.equal(result.wrote, true);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].linkedinUrl, 'https://www.linkedin.com/in/ACwAAAxxx');
    assert.equal(updateCalls[0].linkedinColumn, 'Linkedin URL');
    assert.equal(updateCalls[0].tracking.Reply, 'yes');
    assert.ok(updateCalls[0].tracking.ReplyAt.startsWith(new Date(ts).toISOString().slice(0, 10)));
    assert.match(updateCalls[0].tracking.ReplyPreview, /thanks/i);
  } finally {
    _setDeps(null);
  }
});

test('performWriteBack: calls updateSheetRow when getSheetRowStatus returns null (row not found)', async () => {
  const updateCalls = [];
  _setDeps({
    getSheetRowStatus: async () => null, // webapp unavailable or row not found
    updateSheetRow: async (...args) => { updateCalls.push(args); return true; },
  });
  try {
    const result = await performWriteBack(
      'https://sheet.example',
      'https://www.linkedin.com/in/ACwAAAyyy',
      { text: 'Reply text', deliveredAt: Date.now() },
      'Linkedin URL',
    );
    assert.equal(result.wrote, true, 'null status should not block writes');
    assert.equal(updateCalls.length, 1);
  } finally {
    _setDeps(null);
  }
});

test('performWriteBack: truncates ReplyPreview to 100 chars', async () => {
  const updateCalls = [];
  _setDeps({
    getSheetRowStatus: async () => ({ Reply: '' }),
    updateSheetRow: async (...args) => { updateCalls.push(args); return true; },
  });
  try {
    const longText = 'a'.repeat(500);
    await performWriteBack(
      'https://sheet.example',
      'https://www.linkedin.com/in/ACwAAAzzz',
      { text: longText, deliveredAt: Date.now() },
      'Linkedin URL',
    );
    const preview = updateCalls[0][2].ReplyPreview;
    assert.equal(preview.length, 100);
  } finally {
    _setDeps(null);
  }
});

test('performWriteBack: respects case/whitespace on Reply="yes" check', async () => {
  // Validates the contract between performWriteBack and shouldWriteReply —
  // if someone breaks shouldWriteReply's normalization, this catches it at
  // the orchestrator boundary (not just the unit test).
  const updateCalls = [];
  _setDeps({
    getSheetRowStatus: async () => ({ Reply: ' YES ' }),
    updateSheetRow: async (...args) => { updateCalls.push(args); return true; },
  });
  try {
    const result = await performWriteBack(
      'https://sheet.example',
      'https://www.linkedin.com/in/ACwAAAaaa',
      { text: 'New', deliveredAt: Date.now() },
      'Linkedin URL',
    );
    assert.equal(result.wrote, false);
    assert.equal(updateCalls.length, 0);
  } finally {
    _setDeps(null);
  }
});
