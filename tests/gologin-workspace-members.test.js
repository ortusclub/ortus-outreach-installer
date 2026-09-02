/**
 * Workspace membership by person. Sam runs Linked Velocity accounts from his
 * Ortus login; nobody else at Ortus gains anything by it.
 */
import test from 'node:test';
import assert from 'node:assert';
import { canOperatorUseProfile, profileUsableFor, accountForEmail } from '../src/gologin-accounts.js';

const LV_PROFILE = '68a1b2c3d4e5f60718293a4b'; // any Linked Velocity-owned profile

test('a named member drives the other workspace', () => {
  assert.equal(canOperatorUseProfile('sam@ortusclub.com', 'linkedvelocity', LV_PROFILE), true);
  assert.equal(canOperatorUseProfile('SAM@ortusclub.com', 'linkedvelocity', LV_PROFILE), true);
  assert.equal(canOperatorUseProfile('info@linkedinvelocity.com', 'linkedvelocity', LV_PROFILE), true);
});

test('membership is per person, not per domain', () => {
  assert.equal(canOperatorUseProfile('someoneelse@ortusclub.com', 'linkedvelocity', LV_PROFILE), false);
  assert.equal(canOperatorUseProfile('', 'linkedvelocity', LV_PROFILE), false);
});

test('membership widens who, never who owns it', () => {
  // Still an Ortus operator everywhere else — his own workspace is unchanged.
  assert.equal(accountForEmail('sam@ortusclub.com'), 'ortus');
  // And a granted workspace still answers to its owner's mode rules.
  assert.equal(profileUsableFor('sam@ortusclub.com', 'linkedvelocity', 'connect_and_message', LV_PROFILE), true);
  assert.equal(profileUsableFor('sam@ortusclub.com', 'marketing', 'connect_and_message', LV_PROFILE), false);
});
