import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoster } from '../../src/connections/magellan-roster.js';

test('membership persists, pause survives refresh, deletion keeps data and is not re-seeded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'magellan-roster-'));
  try {
    const file = join(dir, 'roster.json');
    const data = join(dir, 'a.csv');
    writeFileSync(data, 'saved connections');
    const roster = createRoster(file);
    const account = { profileId: 'p1', account: 'a@example.com', collected: true };
    roster.seed([account]);
    roster.add([account]);
    assert.equal(roster.list().length, 1);
    roster.action('p1', 'pause');
    assert.equal(createRoster(file).list()[0].paused, true);
    roster.action('p1', 'resume');
    assert.equal(roster.list()[0].paused, false);
    roster.action('p1', 'delete');
    roster.seed([account]);
    assert.deepEqual(roster.list(), []);
    assert.equal(readFileSync(data, 'utf8'), 'saved connections');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
