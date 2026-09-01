import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfileId } from '../src/gologin-launcher.js';

const profiles = [
  { id: '64d0aa001122334455667788', name: 'damiano@ortus.solutions' },
  { id: '64d0bb001122334455667788', name: ' Emanuele.Circi@ortus.solutions ' },
];

test('GoLogin opener preserves a real profile id', () => {
  assert.equal(resolveProfileId(profiles, profiles[0].id), profiles[0].id);
});

test('GoLogin opener resolves an account email to the exact profile id', () => {
  assert.equal(resolveProfileId(profiles, 'DAMIANO@ORTUS.SOLUTIONS'), profiles[0].id);
  assert.equal(resolveProfileId(profiles, 'emanuele.circi@ortus.solutions'), profiles[1].id);
});

test('GoLogin opener refuses unknown or ambiguous names', () => {
  assert.equal(resolveProfileId(profiles, 'missing@ortus.solutions'), null);
  assert.equal(resolveProfileId([...profiles, { id: 'duplicate', name: profiles[0].name }], profiles[0].name), null);
});
