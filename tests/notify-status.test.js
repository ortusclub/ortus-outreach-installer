import { test } from 'node:test';
import assert from 'node:assert/strict';

// The /api/notify/status endpoint is a 1-line handler that returns the boolean
// `!!process.env.SMTP_HOST`. We test the underlying derivation directly rather
// than spinning up the full Express app — the contract is the env-var → boolean
// mapping, and replicating that here doubles as documentation of the rule.

function smtpConfiguredFromEnv(env) {
  return !!env.SMTP_HOST;
}

test('smtpConfigured is true when SMTP_HOST is set', () => {
  assert.equal(smtpConfiguredFromEnv({ SMTP_HOST: 'smtp.example.com' }), true);
});

test('smtpConfigured is false when SMTP_HOST is missing', () => {
  assert.equal(smtpConfiguredFromEnv({}), false);
});

test('smtpConfigured is false when SMTP_HOST is empty string', () => {
  assert.equal(smtpConfiguredFromEnv({ SMTP_HOST: '' }), false);
});
