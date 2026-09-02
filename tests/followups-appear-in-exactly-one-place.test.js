import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the card asks for ONE campaign, never the whole app', () => {
  // The unscoped call is what printed another campaign's totals on every card.
  assert.match(APP, /followups\/health\?\$\{_q\}/);
  assert.match(APP, /campaignId=\$\{encodeURIComponent\(id\)\}/);
  assert.equal(/fetch\('\/api\/followups\/health'\)/.test(APP), false,
    'the unscoped whole-app fetch must not come back');
});

test('the strip is told which campaigns are on the board', () => {
  // Without this the strip and the cards would both claim the same follow-ups.
  assert.match(APP, /liveCampaignIds=/);
  assert.match(APP, /liveProfileIds=/);
  assert.match(APP, /\['running', 'queued', 'idle'\]\.includes\(it\.bucket\)/);
});

test('the strip has a mount point above the board rails', () => {
  const strip = HTML.indexOf('id="stale-followups"');
  const board = HTML.indexOf('id="campaigns-board"');
  assert.ok(strip > 0 && board > 0);
  assert.ok(strip < board, 'the strip must render above the campaign rails');
});

test('a repaint reopens the messages the operator had open', () => {
  // A board tick must not slam a long message shut mid-read.
  assert.match(APP, /const wasOpen = new Set/);
  assert.match(APP, /if \(!wasOpen\.has\(el\.dataset\.key\)\) continue;/);
});

test('discard offers an Undo, and the toast can carry one', () => {
  assert.match(APP, /label: 'Undo', onClick: \(\) => undoDiscardFollowups\(\)/);
  assert.match(APP, /function showCampaignToast\(msg, duration = 6000, action = null\)/);
  // Plain toasts must stay text-only so a campaign name can never inject markup.
  assert.match(APP, /toast\.appendChild\(document\.createTextNode\(msg\)\)/);
});
