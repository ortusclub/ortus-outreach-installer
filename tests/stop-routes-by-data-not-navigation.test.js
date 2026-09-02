// Stop on the live card did nothing, twice, and said nothing anywhere the
// operator could see.
//
// COLL_CHI_ANTONIO2 (e4f26bc2-cec9-44a7-8b07-c89e1876215c) was monitoring on
// the VM. #btn-active-stop calls dashStopActive(), which routed on
// `_viewingCloudId` — a NAVIGATION flag, set only when the operator opens a
// cloud campaign, and empty on every fresh app start because it is module
// state. The app had been restarted, so it was empty, Stop fell through to the
// local path, and stopCampaign() flipped _abort on a singleton holding no
// campaign. Backend log at 10:19:16 and 10:19:40 UTC on 2026-09-01:
//   ■ Stop requested (full halt — no monitoring, no auto-intros).
// The engine was never contacted. The campaign kept monitoring.
//
// Two rules come out of it:
//   1. Routing reads the DATA on the card, not where the operator has been.
//   2. When nothing is stopped, the campaign's own log says so.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');
const camp = fs.readFileSync(fileURLToPath(new URL('../src/campaign.js', import.meta.url)), 'utf8');

function lift(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  // Skip the PARAMETER list before looking for the body: stopCampaign's params
  // are destructured ({ full = false, ... }), so a naive search for the first
  // '{' lands inside them and the brace counter closes on the wrong one.
  let p = src.indexOf('(', start);
  let pd = 0;
  for (; p < src.length; p += 1) {
    if (src[p] === '(') pd += 1;
    else if (src[p] === ')') { pd -= 1; if (pd === 0) break; }
  }
  const i = src.indexOf('{', p);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const make = (viewing, activeStatus) => new Function('window', `
  const _viewingCloudId = ${JSON.stringify(viewing)};
  ${lift(app, '_activeCardCloudId')}
  return _activeCardCloudId();
`)({ __cloudActiveStatus: activeStatus });

test('an explicitly opened cloud campaign still routes to the engine', () => {
  assert.equal(make('abc-123', null), 'abc-123');
});

test('THE BUG: a restarted app still finds the cloud id on the card', () => {
  // _viewingCloudId is empty after a restart; the rendered status is not.
  const status = { _cloud: true, id: 'e4f26bc2-cec9-44a7-8b07-c89e1876215c', state: 'monitoring' };
  assert.equal(make(null, status), 'e4f26bc2-cec9-44a7-8b07-c89e1876215c',
    'Stop must reach the engine even when the operator never opened the campaign');
});

test('a genuinely local card yields no cloud id, so the local path still runs', () => {
  assert.equal(make(null, { _cloud: false, id: 'legacy-singleton' }), '');
  assert.equal(make(null, null), '');
  assert.equal(make(null, { id: 'legacy-singleton' }), '');
});

test('a cloud status with no id is not treated as a cloud campaign', () => {
  assert.equal(make(null, { _cloud: true }), '', 'never post a stop to an empty id');
});

test('stopCampaign tells the truth in the campaign log when nothing is running here', () => {
  const fn = lift(camp, 'stopCampaign');
  assert.match(fn, /nothingRunningHere/, 'the no-op case must be detected');
  assert.match(fn, /nothing here was stopped/i, 'and must be stated in the log');
  assert.match(fn, /Cloud VM/, 'and must point the operator at where it actually runs');
  // The full-halt wording must sit behind the condition, not be logged
  // unconditionally as it was. (Searching for the phrase alone is not enough:
  // it also appears in the comment recording the incident.)
  assert.match(fn, /nothingRunningHere[\s\S]*?full\s*\?\s*'■ Stop requested \(full halt/,
    'the full-halt line must sit behind the "is anything running" branch');
});

test('quitting the app is logged as a quit, not as a Stop the operator pressed', () => {
  const fn = lift(camp, 'stopCampaign');
  // gracefulShutdown calls stopCampaign() too, and the operator wording used to
  // apply to it: every quit ended the log with "Stop pressed, but nothing is
  // running" (Sam, 1 Sep). Behaviour is covered in
  // tests/quitting-is-not-a-stop-press.test.js; this pins that the branch is the
  // OUTERMOST one, so no quit can ever reach the operator wording.
  assert.match(fn, /log\(quitting\s*\?/,
    'the log call must branch on quitting before it branches on anything else');
});
