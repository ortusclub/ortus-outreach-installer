import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateConnectIdentity, campaign } from '../src/campaign.js';
import { getPrefs } from '../src/operator-prefs.js';

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
