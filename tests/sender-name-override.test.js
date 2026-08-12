import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Typed-in {sender first name} for accounts with no usable SoO row. app.js is a
// browser bundle with no exports, so these are source assertions — the approach
// mode-locks.test.js and retired-modes.test.js already use here.
//
// What they protect: without an override, a no-SoO account's sender name falls
// through to `profileName.split(' ')[0]` at send time (campaign.js:3594), and
// profileName is the GoLogin label — the account's email. The lead reads
// "Hi Jerome, nabungaires@gmail.com here".

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('the SoO name still wins; the override is the fallback', () => {
  // Precedence matters: a row added to the SoO later must supersede a stale
  // typed-in name, not lose to it forever.
  assert.match(APP, /return fromSoO \|\| getSenderNameOverride\(profileName\);/);
  // A row with a BLANK First Name resolves to '' and falls through to the
  // override too — that's why fromSoO is computed rather than early-returned.
  assert.match(APP, /const fromSoO = soo \? \(soo\['First Name'\] \|\| soo\.firstName \|\| ''\)\.toString\(\)\.trim\(\) : '';/);
});

test('overrides are keyed by profile name, not profile id', () => {
  // GoLogin profile ids change when a profile is recreated; the email doesn't.
  assert.match(APP, /function overrideKeyForProfile\(profileName\) \{/);
  assert.match(APP, /return String\(profileName \|\| ''\)\.trim\(\)\.toLowerCase\(\);/);
});

test('clearing the box removes the override rather than storing an empty one', () => {
  // An empty-string entry would out-rank nothing but would survive a later SoO
  // fix as dead weight in localStorage.
  assert.match(APP, /if \(v\) senderFirstNameOverrides\[k\] = v;\s*\n\s*else delete senderFirstNameOverrides\[k\];/);
});

test('a corrupt localStorage entry cannot take the account picker down', () => {
  // The picker is the first screen of a campaign — a JSON.parse throw here
  // would leave the operator with no accounts and no explanation.
  assert.match(APP, /return \(parsed && typeof parsed === 'object' && !Array\.isArray\(parsed\)\) \? parsed : \{\};/);
  assert.match(APP, /\} catch \{ return \{\}; \}/);
});

test('the tile binds selection to the checkbox, not the name input', () => {
  // The tile now holds two <input>s. A bare querySelector('input') would bind
  // account selection to whichever the markup puts first.
  assert.match(APP, /const cb = item\.querySelector\('input\[type="checkbox"\]'\);/);
});

test('the name input never toggles the tile it sits inside', () => {
  // The tile is a <label>, so a click on the input would otherwise check the box.
  assert.match(APP, /nameInput\.addEventListener\('click', \(e\) => e\.stopPropagation\(\)\);/);
});
