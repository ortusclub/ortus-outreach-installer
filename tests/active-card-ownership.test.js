// Screen recording 2026-08-27 17:18: pressing Open on the stopped VM campaign
// "CC+IC TOAST TEST" showed TEST_24/08_CC+IC_A's live status card instead —
// the campaign that had been handed to this Mac and was monitoring. pollStatus
// repaints the shared #active-card every 2s on every route with the LOCAL
// status and never asked which campaign the operator was viewing.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');
function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in app.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
const accepts = new Function(`${lift('activeCardAcceptsStatus')}; return activeCardAcceptsStatus;`)();

test('a poller carrying another campaign cannot repaint the viewed card', () => {
  assert.equal(accepts('cmp_toast', 'cmp_24_08'), false);
});

test('the viewed campaign still paints its own status', () => {
  assert.equal(accepts('cmp_toast', 'cmp_toast'), true);
});

test('a campaign adopted by this Mac keeps painting under its cloud id', () => {
  // src/campaign.js:6428 reports the adopted cloud id, not the local singleton.
  assert.equal(accepts('cmp_adopted', 'cmp_adopted'), true);
});

test('nothing is blocked when either side is unidentified', () => {
  assert.equal(accepts('', 'cmp_24_08'), true, 'no campaign is being viewed');
  assert.equal(accepts('cmp_toast', ''), true, 'clearing the card still works');
  assert.equal(accepts(null, null), true);
});

test('Open pins the selected campaign before revealing the shared card', () => {
  const start = src.indexOf('async function openRunningCampaignReadOnly');
  const end = src.indexOf('window.openRunningCampaignReadOnly', start);
  const open = src.slice(start, end);
  const bindAt = open.indexOf('_bindLiveStatusToCampaign(id, _it ? statusFromItem(_it) : null)');
  const navigateAt = open.indexOf('goCreateCampaign()');
  assert.ok(bindAt >= 0, 'the selected Dashboard item seeds Live Status');
  assert.ok(navigateAt >= 0, 'the Campaign page is opened');
  assert.ok(bindAt < navigateAt, 'the exact campaign must paint before the shared card becomes visible');
});

test('binding synchronously replaces the stale aggregate before fetching detail', () => {
  const start = src.indexOf('function _bindLiveStatusToCampaign');
  const end = src.indexOf('// v2.160.46: OPEN', start);
  const bind = src.slice(start, end);
  const seedAt = bind.indexOf('window.__cloudActiveStatus = seededStatus');
  const renderAt = bind.indexOf('renderActiveCard(seededStatus)');
  const fetchAt = bind.indexOf('Promise.resolve(_refreshCloudActiveStatus(id))');
  assert.ok(seedAt >= 0 && renderAt >= 0 && fetchAt >= 0);
  assert.ok(seedAt < fetchAt && renderAt < fetchAt,
    'the selected campaign must replace the generic summary without waiting for the network');
});
