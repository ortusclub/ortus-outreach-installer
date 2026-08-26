import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('a newer authoritative lead result advances the top banner beyond stale browser progress', () => {
  assert.match(app, /if \(d\) d\._leads = leads;/);
  assert.match(app, /normLead\(l\.fullName\) === normLead\(who\)/);
  assert.match(app, /Latest verified event/);
  assert.match(app, /sent and confirmed/);
  assert.match(app, /\['Sheet', ok \? 'result stamped' : 'error stamped', 'done'\]/);
});
