// Signup gate — who may create an account in the app.
//
// Two ways in: an allowed corporate DOMAIN, or a named external collaborator on
// the per-email list. The per-email list is the one that must stay tight: it
// grants one person access without opening their employer's whole domain, and
// nothing else in the app re-checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEmailAllowed } from '../src/auth.js';
import { SIGNUP_ALLOWED_DOMAINS, SIGNUP_ALLOWED_EMAILS } from '../src/sheets-webapp-url.js';

test('Ortus domains sign up', async () => {
  for (const domain of SIGNUP_ALLOWED_DOMAINS) {
    assert.equal(await isEmailAllowed(`someone@${domain}`), true, domain);
  }
});

test('each named external collaborator is allowed, case-insensitively', async () => {
  for (const email of SIGNUP_ALLOWED_EMAILS) {
    assert.equal(await isEmailAllowed(email), true, email);
    assert.equal(await isEmailAllowed(email.toUpperCase()), true, `${email} (upper-case)`);
    assert.equal(await isEmailAllowed(`  ${email}  `), true, `${email} (padded)`);
  }
});

test('a collaborator grant does NOT open their whole domain', async () => {
  // The point of the per-email list. If this ever fails, one named partner has
  // silently become "anyone at that company".
  for (const email of SIGNUP_ALLOWED_EMAILS) {
    const domain = email.split('@')[1];
    assert.equal(await isEmailAllowed(`someone-else@${domain}`), false,
      `${domain} must not be open to everyone`);
  }
});

test('everyone else is refused', async () => {
  for (const email of ['stranger@gmail.com', 'attacker@evil.test', 'not-an-email', '']) {
    assert.equal(await isEmailAllowed(email), false, email);
  }
});
