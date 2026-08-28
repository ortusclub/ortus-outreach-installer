// _mergeCloudLog + _cloudLeadsToLog live inside app.js (no module boundary), so
// the ordering rule is exercised by lifting the two functions out of the source
// the browser actually loads. Ordering is the merge's job: the status banner
// reads the log's LAST row, so a row in the wrong place is a wrong banner.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');

function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in app.js`);
  // Walk braces from the signature to the matching close.
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// _mergeCloudLog stamps each event with logClock, which lives in the same
// module — lift it too, or the merge dates nothing.
// eslint-disable-next-line no-new-func
const mergeCloudLog = new Function(`${lift('logClock')}; ${lift('_mergeCloudLog')}; return _mergeCloudLog;`)();

test('an undated lead row never sits below timestamped live events', () => {
  const at = (h, m) => new Date(2026, 7, 27, h, m).getTime();
  const lines = mergeCloudLog([
    { t: at(15, 18), line: '✓ Marybeth Wolff · CC sent · 15:18' },
    // No sentAt on the sheet row, so _cloudLeadsToLog cannot date it.
    { t: undefined, line: '✓ Juan C. Rojas, MD, MS · Connected sent · via sean.alcosin@ortus.solutions' },
    { t: Infinity, line: '──────────' },
    { t: Infinity, line: 'Σ Total · 91 sent · 1 error · 107 pending' },
  ], [
    { t: at(15, 18), line: '▶ cindy.siapno@ortus.solutions · Marybeth Wolff — Stamping the result to the sheet' },
  ]);
  assert.match(lines[0], /Juan C\. Rojas/);
  assert.match(lines[lines.length - 3], /Stamping the result/);
  assert.equal(lines[lines.length - 2], '──────────');
  assert.match(lines[lines.length - 1], /^Σ Total/);
});

test('an undated ENGINE event still lands at the end — it was just emitted', () => {
  const lines = mergeCloudLog(
    [{ t: new Date(2026, 7, 27, 15, 18).getTime(), line: '✓ Marybeth Wolff · CC sent · 15:18' }],
    [{ t: null, line: '⏸ Paused by the operator' }],
  );
  assert.match(lines[lines.length - 1], /Paused by the operator/);
});

test('a sent lead with no sentAt is dated from dateLastAction', () => {
  assert.match(
    src,
    /return \{ t: ts\(l\.sentAt\) \|\| ts\(l\.dateLastAction\), line: `✓ \$\{name\}/,
    'the sent branch of _cloudLeadsToLog must fall back to dateLastAction for its sort key',
  );
});
