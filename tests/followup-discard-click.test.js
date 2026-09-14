import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { groupKeyOf } from '../src/followup-groups.js';

test('discard click passes a legacy message key with apostrophes unchanged', () => {
  const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const handler = src.match(/onclick="(discardStaleFollowups[^"\n]+)"/)[1]
    .replace('${g.count}', '1');
  const key = groupKeyOf({ body: "Hi Max, we're hosting a dinner. It's tomorrow.", leadName: 'Max' });
  const button = { closest: () => ({ dataset: { key } }) };
  let received;
  vm.runInNewContext(`(function () { ${handler} }).call(button)`, {
    button, discardStaleFollowups: (...args) => { received = args; },
  });
  assert.equal(received[0], key);
  assert.equal(received[1], 1);
  assert.equal(received[2], button);
});
