// The Apps Script's direct-row fast path (rowByNumberIfItMatches) — the engine
// sends each lead's imported row number; the script writes there only when the
// URL cell at that row is the same lead, else it falls back to the scan.
// google-apps-script.js runs on Google's servers, so the function is lifted
// out of the file by name and run against a fake sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../google-apps-script.js', import.meta.url), 'utf8');
function lift(name) {
  const m = src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
  assert.ok(m, `${name} not found in google-apps-script.js`);
  return m[0];
}
const fns = new Function(`${lift('normalizeUrl')}\n${lift('rowByNumberIfItMatches')}\nreturn { rowByNumberIfItMatches };`)();

const fakeSheet = (urls) => ({
  getLastRow: () => urls.length + 1,
  getRange: (row, col) => ({ getValue: () => (col === 3 ? urls[row - 2] : '') }),
});

test('a matching row number is used directly', () => {
  const sheet = fakeSheet(['https://www.linkedin.com/in/alpha/', 'https://www.linkedin.com/in/beta']);
  assert.deepEqual(fns.rowByNumberIfItMatches(sheet, 2, 3, 'https://linkedin.com/in/beta/'), [3]);
});

test('a stale row number falls back (null) instead of stamping a stranger', () => {
  const sheet = fakeSheet(['https://www.linkedin.com/in/alpha/', 'https://www.linkedin.com/in/beta']);
  assert.equal(fns.rowByNumberIfItMatches(sheet, 2, 2, 'https://www.linkedin.com/in/beta'), null);
});

test('missing, header, or out-of-range numbers are ignored', () => {
  const sheet = fakeSheet(['https://www.linkedin.com/in/alpha/']);
  assert.equal(fns.rowByNumberIfItMatches(sheet, 2, undefined, 'https://www.linkedin.com/in/alpha'), null);
  assert.equal(fns.rowByNumberIfItMatches(sheet, 2, 1, 'https://www.linkedin.com/in/alpha'), null);
  assert.equal(fns.rowByNumberIfItMatches(sheet, 2, 9, 'https://www.linkedin.com/in/alpha'), null);
});
