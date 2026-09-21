import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('Done and Stopped section clears persist local and cloud removals', () => {
  assert.match(app, /fetch\('\/api\/history\/delete-batch'/);
  assert.match(app, /body: JSON\.stringify\(\{ indexes: localHistoryIndexes \}\)/);
  assert.match(app, /Number\(result\.deleted\) !== new Set\(localHistoryIndexes\)\.size/);
  assert.match(app, /_cloudSaveDismissed\(\)/);
  assert.match(app, /_localSaveDismissed\(\)/);
  assert.match(app, /localStorage\.setItem\('localDismissedDone'/);
});

test('a failed durable history delete does not pretend the cards were removed', () => {
  const clearStart = app.indexOf('async function clearBoardCat');
  const clearEnd = app.indexOf('window.clearBoardCat = clearBoardCat', clearStart);
  const clearBody = app.slice(clearStart, clearEnd);
  assert.ok(clearBody.indexOf("fetch('/api/history/delete-batch'") < clearBody.indexOf("_cloudDismissed.add(it.id)"));
  assert.match(clearBody, /catch \(error\) \{[\s\S]*return;[\s\S]*\}/);
});
