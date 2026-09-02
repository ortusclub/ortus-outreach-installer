/**
 * The operator email decides which GoLogin workspaces the tiles say you may
 * drive, and the server stamps that verdict on at fetch time. Changing the
 * email must therefore re-fetch, or the roster keeps the previous operator's
 * answer and every account of the workspace you just joined reads OTHER TEAM.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf-8');
const save = app.slice(app.indexOf('async function saveOperatorEmail()'), app.indexOf('document.addEventListener(\'DOMContentLoaded\', initOperatorIdentity)'));

test('saving a new identity re-fetches the roster', () => {
  assert.match(save, /await loadProfiles\(\)/);
});

test('it happens after the save succeeded, not before', () => {
  assert.ok(save.indexOf('_setOperatorChip(d.email)') < save.indexOf('await loadProfiles()'));
  // and never on the failure path, which returns early
  const fail = save.slice(0, save.indexOf('_setOperatorChip'));
  assert.doesNotMatch(fail, /loadProfiles/);
});

test('a failed refresh does not swallow the saved identity', () => {
  assert.match(save, /try \{ await loadProfiles\(\); \} catch/);
});
