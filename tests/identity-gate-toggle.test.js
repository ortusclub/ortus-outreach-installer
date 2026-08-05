import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateConnectIdentity, campaign } from '../src/campaign.js';
import { getPrefs, identityGateEnabled } from '../src/operator-prefs.js';

// v2.113.x: operator toggle for the pre-send identity safeguard.
//   OFF (default, 2026-06-22) → behave like pre-gate v2.97: navigate to the
//                   sheet URL and connect to whatever loads, NO name/member
//                   matching, NO 5× retry loop — but KEEP the 404 dead-profile
//                   short-circuit. The wrong-person send was a connect-button
//                   bug (fixed in sendConnectionRequest), not a mis-loaded URL,
//                   so the gate was friction; operators opt back IN if they want.
//   ON            → full identity verification (the original gate behavior).
//
// The gate is browser-driven (needs a live `page`), so these tests exercise the
// blind-mode branch with a minimal fake page. We assert the SHAPE of the result
// and that only a single navigation happens (proving the verify loop +
// captureProfileMeta were skipped).

function makePage({ landUrl, notFound = false, throwOnGoto = false }) {
  const calls = { goto: [] };
  return {
    calls,
    goto: async (u) => {
      calls.goto.push(u);
      if (throwOnGoto) throw new Error('nav boom');
    },
    url: () => landUrl,
    // pageShowsProfileNotFound() does page.evaluate(() => …) and returns it.
    evaluate: async () => notFound,
  };
}

test('default operator pref ships the identity safeguard OFF (2026-06-22)', async () => {
  const prefs = await getPrefs(''); // no email → pure DEFAULTS, no disk read
  assert.equal(prefs.identityGate, false);
});

test('blind mode (verifyIdentity:false) passes a healthy profile without verifying', async () => {
  campaign._abort = false;
  const page = makePage({ landUrl: 'https://www.linkedin.com/in/jane-doe/' });
  const res = await gateConnectIdentity(page, {
    url: 'https://www.linkedin.com/in/jane-doe/',
    row: {},
    sourceName: 'Jane Doe',
    verifyIdentity: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.navigated, true);
  assert.match(res.reason, /disabled/);
  // single navigation, no retry loop, no captureProfileMeta/render wait
  assert.equal(page.calls.goto.length, 1);
});

test('blind mode still skips a /404 dead URL', async () => {
  campaign._abort = false;
  const page = makePage({ landUrl: 'https://www.linkedin.com/404/' });
  const res = await gateConnectIdentity(page, {
    url: 'https://www.linkedin.com/in/dead/',
    row: {},
    verifyIdentity: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.notFound, true);
  assert.equal(res.reason, 'profile_not_found_404');
});

test('blind mode catches the "this page doesn\'t exist" interstitial', async () => {
  campaign._abort = false;
  const page = makePage({ landUrl: 'https://www.linkedin.com/in/dead/', notFound: true });
  const res = await gateConnectIdentity(page, {
    url: 'https://www.linkedin.com/in/dead/',
    row: {},
    verifyIdentity: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.notFound, true);
});

test('blind mode tolerates a navigation glitch (lets the send re-navigate)', async () => {
  campaign._abort = false;
  const page = makePage({ landUrl: '', throwOnGoto: true });
  const res = await gateConnectIdentity(page, {
    url: 'https://www.linkedin.com/in/x/',
    row: {},
    verifyIdentity: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.navigated, false);
});

// ─── The toggle must reach the VM, not just the local runner ────────────────
//
// 2026-08-05: the sidebar read "Identity safeguard · Off" while a cloud campaign
// logged `identity_unverified (name-mismatch …)` on every lead and sent nothing.
// The launch payload never carried the pref, and the engine reads
// `cfg.identityGateEnabled !== false` — so an ABSENT key resolved to ON. Local
// and cloud read the same pref through opposite defaults.
//
// identityGateEnabled() is now the single mapping both sides call. These pin the
// property that matters: it always returns a real boolean, so the engine's
// `!== false` can never see `undefined` and turn the gate on behind the toggle.

test('identityGateEnabled never returns undefined — the value the engine reads as ON', async () => {
  for (const input of [null, undefined, {}, { tz: 'Europe/Zurich' }]) {
    assert.equal(typeof identityGateEnabled(input), 'boolean', `input: ${JSON.stringify(input)}`);
  }
});

test('identityGateEnabled mirrors the operator pref, defaulting OFF', async () => {
  assert.equal(identityGateEnabled({ identityGate: true }), true);
  assert.equal(identityGateEnabled({ identityGate: false }), false);
  assert.equal(identityGateEnabled({}), false, 'a pref file without the key is OFF, as local has always read it');
  assert.equal(identityGateEnabled(null), false, 'no operator is OFF');
});

test('the value survives the engine gate expression it is fed into', async () => {
  // campaign-action.js: `verifyIdentity: cfg.identityGateEnabled !== false`
  const asEngineReadsIt = (v) => v !== false;
  assert.equal(asEngineReadsIt(identityGateEnabled({ identityGate: false })), false,
    'toggle OFF must reach the engine as OFF — the bug was this landing on true');
  assert.equal(asEngineReadsIt(identityGateEnabled({ identityGate: true })), true);
  assert.equal(asEngineReadsIt(undefined), true,
    'and the absent key really did mean ON — which is why it had to be sent');
});
