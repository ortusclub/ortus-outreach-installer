import { test } from 'node:test';
import assert from 'node:assert';
import { handoverBanner } from '../public/js/runpanel.mjs';

test('moving to the VM names both ends and says what to do', () => {
  const b = handoverBanner({ to: 'cloud', name: 'MAEN_ANZ_HOB' });
  assert.equal(b.tone, 'to-cloud');
  assert.equal(b.l1, 'Moving to the Cloud VM');
  assert.match(b.l2, /MAEN_ANZ_HOB/);
  assert.match(b.l2, /this Mac/);
  assert.match(b.l2, /VM/);
  assert.equal(b.right[0], 'Leave it open');
});

test('coming back to this Mac reverses the tone', () => {
  const b = handoverBanner({ to: 'local', name: 'MAEN_ANZ_HOB' });
  assert.equal(b.tone, 'to-local');
  assert.equal(b.l1, 'Coming back to this Mac');
  assert.match(b.right[1], /stops the run/);
});

test('the landed state says what the operator can now do', () => {
  const a = handoverBanner({ to: 'cloud', name: 'X', landed: true });
  assert.match(a.right[1], /[Ss]afe to close/);
  assert.match(a.l2, /acceptance check starts/);
  const b = handoverBanner({ to: 'local', name: 'X', landed: true });
  assert.match(b.right[1], /[Kk]eep the app open/);
  assert.match(b.l2, /acceptance check starts/);
});

test('never a bare Handover, and never an em dash', () => {
  for (const to of ['cloud', 'local']) {
    for (const landed of [false, true]) {
      const b = handoverBanner({ to, name: 'X', landed });
      const all = `${b.l1} ${b.l2} ${b.right.join(' ')}`;
      assert.ok(!all.includes('—'), `em dash in ${to}/${landed}`);
      assert.notEqual(b.l1.trim(), 'Handover');
    }
  }
});
