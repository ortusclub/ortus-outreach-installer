// A VM event the APP observes must be stamped with the engine's own step time,
// not with the poll that noticed it. _mergeCloudLog sorts by that stamp and the
// status banner reads the log's last row, so a late stamp reorders the log and
// then mislabels the card.
//
// COLL_CHI_ANTONIO2, 2026-08-27: matt.adcock's browser closed at 13:44:54; the
// app saw the breadcrumb gone after 13:45:29 and stamped it then, pushing
// "browser closed" below the engine's "Check complete" and "Next check".
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');

function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// eslint-disable-next-line no-new-func
const stepTime = new Function(`${lift('_engineStepTime')}; return _engineStepTime;`)();

test('the engine step time is read from ms or ISO, and 0 when absent', () => {
  assert.equal(stepTime(1787838294488), 1787838294488);
  assert.equal(stepTime('2026-08-27T13:44:54.488Z'), Date.parse('2026-08-27T13:44:54.488Z'));
  assert.equal(stepTime(''), 0);
  assert.equal(stepTime(undefined), 0);
  assert.equal(stepTime('not a time'), 0);
});

test('an observed browser-close is stamped from the turn, not from the poll', () => {
  // eslint-disable-next-line no-new-func
  const harness = new Function(`
    const _cloudEventLog = new Map();
    ${lift('_engineStepTime')}
    ${lift('_pushCloudEvent')}
    return { _cloudEventLog, _pushCloudEvent };
  `)();
  const closedAt = 1787838294488;            // 13:44:54, the real close
  harness._pushCloudEvent('c1', '■ matt.adcock — browser closed', closedAt);
  const [row] = harness._cloudEventLog.get('c1');
  assert.equal(row.t, closedAt);
  // It must sort BELOW the engine's 13:45:29 lines, not above them.
  assert.ok(row.t < 1787838329282, 'browser-close must precede Check complete');
});

test('with no engine step time it still records, falling back to now', () => {
  // eslint-disable-next-line no-new-func
  const harness = new Function(`
    const _cloudEventLog = new Map();
    ${lift('_engineStepTime')}
    ${lift('_pushCloudEvent')}
    return { _cloudEventLog, _pushCloudEvent };
  `)();
  const before = Date.now();
  harness._pushCloudEvent('c2', '■ someone — browser closed');
  const [row] = harness._cloudEventLog.get('c2');
  assert.ok(row.t >= before, 'falls back to the observation time rather than 0');
});

test('the close line passes the remembered turn timestamp through', () => {
  assert.match(
    src,
    /browser closed · waiting for the next account turn`, prev\.stepAt\)/,
    'the observed close must carry prev.stepAt',
  );
  assert.match(src, /stepAt: p\.stepAt,/, '_cloudProgressSeen must remember the engine step time');
});
