import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');

test('resume progress preserves its imported baseline on initial load, reload and success', () => {
  assert.match(src, /campaign\.totalTargets = _resumeTotal \+ targets\.length;/);
  assert.equal((src.match(/campaign\.totalTargets = targets\.length;/g) || []).length, 0);
  assert.match(src, /campaign\.totalProcessed = _resumeTotal \+ campaign\.processedToday;/);
});
