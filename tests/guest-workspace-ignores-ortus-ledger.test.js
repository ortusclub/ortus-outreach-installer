/**
 * A profile owned by another GoLogin workspace is tracked by that workspace.
 * The Ortus SoO's credit columns describe somebody else's usage of it, so they
 * must not grey the tile for the operator entitled to use it. A restricted or
 * inaccessible Status still does: that is the LinkedIn account itself.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { classifyAccountState } from '../public/js/account-guardrails.mjs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf-8');
const picker = app.slice(app.indexOf('const _foreign = p.available === false;'), app.indexOf('const _foreign = p.available === false;') + 14000);

test('the lock consults who owns the profile', () => {
  assert.match(picker, /_guestWorkspace\s*=\s*!_foreign\s*&&\s*!!p\.account\s*&&\s*p\.account\s*!==\s*'ortus'/);
});

test('a guest tile keeps the Status lock and drops the credit lock', () => {
  const rule = picker.slice(picker.indexOf('const _sooLock'), picker.indexOf('const _locked'));
  assert.match(rule, /_guestWorkspace/);
  assert.match(rule, /_state\.reason === 'restricted'/);      // Status still locks
  assert.doesNotMatch(rule.split('?')[1] || '', /anyActive/); // credits do not
});

test('a selectable guest tile never still reads "no credits"', () => {
  assert.match(picker, /_guestLedger[\s\S]{0,200}_reason !== 'restricted'/);
  assert.match(picker, /if \(_guestLedger\) _sub =/);
});

// The rows this exists for, in the shape the SoO actually returns them.
test('these are the two verdicts being told apart', () => {
  const rented = { Status: 'Rented', ccCredits: 'NA', section: 'Pool Accounts Unassigned' };
  const restricted = { Status: 'Identity Restricted', ccCredits: 'NA', section: 'Pool Accounts Unassigned' };
  assert.equal(classifyAccountState(rented, 'sam@ortusclub.com', 'connect_and_message').reason, 'na');
  assert.equal(classifyAccountState(restricted, 'sam@ortusclub.com', 'connect_and_message').reason, 'restricted');
});
