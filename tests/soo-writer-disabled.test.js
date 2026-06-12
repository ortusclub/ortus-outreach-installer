import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flipAccountInUse, markAccountNeedsLoginSoO } from '../src/soo-writer.js';

// These tests must NOT hit the network. The kill-switch and blank-email guards
// both short-circuit before any fetch, so they are safe to run offline.

test('flip + needs-login are no-ops when the kill-switch is off (no network)', async () => {
  const orig = process.env.ORTUS_SOO_WRITEBACK;
  process.env.ORTUS_SOO_WRITEBACK = 'off';
  try {
    assert.deepEqual(
      await flipAccountInUse({ email: 'a@x', creditHeader: 'CC (Credits)', userHeader: 'CC User', operatorEmail: 'o@x' }),
      { ok: false, disabled: true },
    );
    assert.deepEqual(
      await markAccountNeedsLoginSoO({ email: 'a@x' }),
      { ok: false, disabled: true },
    );
  } finally {
    if (orig === undefined) delete process.env.ORTUS_SOO_WRITEBACK;
    else process.env.ORTUS_SOO_WRITEBACK = orig;
  }
});

test('flip rejects a blank email before any network call', async () => {
  const orig = process.env.ORTUS_SOO_WRITEBACK;
  delete process.env.ORTUS_SOO_WRITEBACK; // enabled
  try {
    assert.deepEqual(
      await flipAccountInUse({ email: '', creditHeader: 'CC (Credits)', userHeader: 'CC User', operatorEmail: 'o@x' }),
      { ok: false, error: 'no email' },
    );
    assert.deepEqual(await markAccountNeedsLoginSoO({ email: '' }), { ok: false, error: 'no email' });
  } finally {
    if (orig !== undefined) process.env.ORTUS_SOO_WRITEBACK = orig;
  }
});

test('flip rejects missing credit/user headers before any network call', async () => {
  const orig = process.env.ORTUS_SOO_WRITEBACK;
  delete process.env.ORTUS_SOO_WRITEBACK; // enabled
  try {
    assert.deepEqual(
      await flipAccountInUse({ email: 'a@x', creditHeader: '', userHeader: 'CC User', operatorEmail: 'o@x' }),
      { ok: false, error: 'no headers' },
    );
    assert.deepEqual(
      await flipAccountInUse({ email: 'a@x', creditHeader: 'CC (Credits)', userHeader: '', operatorEmail: 'o@x' }),
      { ok: false, error: 'no headers' },
    );
  } finally {
    if (orig !== undefined) process.env.ORTUS_SOO_WRITEBACK = orig;
  }
});
