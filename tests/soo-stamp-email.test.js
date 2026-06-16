import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedOperatorEmails, resolveStampEmail, resolveOperatorStamp } from '../src/soo-writer.js';

test('blockedOperatorEmails: always blocks the admin/shared addresses', () => {
  const blocked = blockedOperatorEmails({});
  assert.ok(blocked.has('ortus@ortusclub.com'));
  assert.ok(blocked.has('antonio@ortusclub.com'));
});

test('blockedOperatorEmails: parses logins out of DASHBOARD_USERS (email:pass,email:pass)', () => {
  const blocked = blockedOperatorEmails({
    DASHBOARD_USERS: 'antonio@ortusclub.com:ortus2026,shared@ortus.solutions:pw',
  });
  assert.ok(blocked.has('shared@ortus.solutions'));
  assert.ok(blocked.has('antonio@ortusclub.com'));
});

test('blockedOperatorEmails: includes the ADMIN_EMAILS list', () => {
  const blocked = blockedOperatorEmails({ ADMIN_EMAILS: 'a@x.com, b@x.com' });
  assert.ok(blocked.has('a@x.com'));
  assert.ok(blocked.has('b@x.com'));
});

test('resolveStampEmail: passes a normal operator email through, preserving case', () => {
  const blocked = blockedOperatorEmails({});
  assert.equal(resolveStampEmail('Alecx@Ortus.Solutions', blocked), 'Alecx@Ortus.Solutions');
  assert.equal(resolveStampEmail('  miguel@ortus.solutions  ', blocked), 'miguel@ortus.solutions');
});

test('resolveStampEmail: blank/undefined → empty (no user cell stamped)', () => {
  assert.equal(resolveStampEmail('', new Set()), '');
  assert.equal(resolveStampEmail(undefined, new Set()), '');
  assert.equal(resolveStampEmail(null, new Set()), '');
});

test('resolveStampEmail: shared/admin login → empty, case-insensitively', () => {
  const blocked = blockedOperatorEmails({ DASHBOARD_USERS: 'antonio@ortusclub.com:ortus2026' });
  assert.equal(resolveStampEmail('antonio@ortusclub.com', blocked), '');
  assert.equal(resolveStampEmail('ANTONIO@ortusclub.com', blocked), '');
  assert.equal(resolveStampEmail('ortus@ortusclub.com', blocked), '');
});

test('resolveOperatorStamp: per-machine email is authoritative — used verbatim', () => {
  const blocked = blockedOperatorEmails({});
  assert.equal(
    resolveOperatorStamp({ perMachineEmail: 'alecx@ortus.solutions', loginEmail: 'antonio@ortusclub.com', blocked }),
    'alecx@ortus.solutions',
  );
});

test('resolveOperatorStamp: per-machine email is NEVER blocked (Antonio on his own machine)', () => {
  const blocked = blockedOperatorEmails({});
  // antonio@ is in the block list, but as an EXPLICIT per-machine choice it stamps.
  assert.equal(
    resolveOperatorStamp({ perMachineEmail: 'antonio@ortusclub.com', loginEmail: 'antonio@ortusclub.com', blocked }),
    'antonio@ortusclub.com',
  );
});

test('resolveOperatorStamp: no per-machine email → falls back to login, blanking shared/admin', () => {
  const blocked = blockedOperatorEmails({ DASHBOARD_USERS: 'antonio@ortusclub.com:x' });
  // shared login → blank (don't mislabel everyone as Antonio)
  assert.equal(resolveOperatorStamp({ perMachineEmail: '', loginEmail: 'antonio@ortusclub.com', blocked }), '');
  // a real individual login → used
  assert.equal(resolveOperatorStamp({ perMachineEmail: '', loginEmail: 'miguel@ortus.solutions', blocked }), 'miguel@ortus.solutions');
});
