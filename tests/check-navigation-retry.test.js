import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bulkCheckConnections, describeTabLocation } from '../src/linkedin/bulk-check-connections.js';
import { sweepHealth } from '../src/campaign.js';
import { diagnose } from '../src/connections/magellan-diagnose.js';

const aborted = () => new Error('net::ERR_ABORTED at https://www.linkedin.com/mynetwork/invite-connect/connections/');

/** Minimal page double: records every goto, answers url() from a script. */
function fakePage({ gotoResults, urls }) {
  const gotos = [];
  let i = 0;
  return {
    gotos,
    url: () => urls[Math.min(gotos.filter((g) => g !== 'about:blank').length, urls.length - 1)],
    goto: async (u) => {
      gotos.push(u === 'about:blank' ? 'about:blank' : 'target');
      if (u === 'about:blank') return;
      const r = gotoResults[i++];
      if (r instanceof Error) throw r;
    },
    evaluate: async () => ({ error: 'no-csrf (tab was on the connections page)' }),
  };
}

test('an aborted navigation is retried, and a late success is used', async (t) => {
  // The account used to be lost outright: one abort skipped it, stamped the
  // whole sweep incomplete and stopped the campaign's sending.
  const page = fakePage({
    gotoResults: [aborted(), null],
    urls: ['https://www.linkedin.com/mynetwork/invite-connect/connections/'],
  });
  const r = await bulkCheckConnections(page, 'https://sheet', '', 'cindy');
  // It got past navigation: the failure it reports now comes from the fetch,
  // not from the navigation.
  assert.ok(!/navigation-failed/.test(String(r.error)), `still failed at nav: ${r.error}`);
  const targets = page.gotos.filter((g) => g === 'target');
  assert.equal(targets.length, 2, 'navigated twice');
  assert.ok(page.gotos.includes('about:blank'), 'reset the tab before retrying');
});

test('three attempts at most, then it reports the tab location', async () => {
  const page = fakePage({
    gotoResults: [aborted(), aborted(), aborted()],
    urls: ['https://www.linkedin.com/feed/'],
  });
  const r = await bulkCheckConnections(page, 'https://sheet', '', 'cindy');
  assert.equal(page.gotos.filter((g) => g === 'target').length, 3, 'one attempt plus two retries');
  assert.match(r.error, /^navigation-failed:/, 'prefix both classifiers key on is preserved');
  assert.match(r.error, /tab was on the feed/, 'says where the browser actually ended up');
});

test('a sign-in wall is named as a login problem and is not retried', async () => {
  // Retrying a checkpoint can never work, and "open the account and retry" is
  // the wrong instruction: somebody has to sign this account back in.
  const page = fakePage({
    gotoResults: [aborted(), null],
    urls: ['https://www.linkedin.com/checkpoint/challenge/abc'],
  });
  const r = await bulkCheckConnections(page, 'https://sheet', '', 'cindy');
  assert.match(r.error, /^session-expired/);
  assert.equal(page.gotos.filter((g) => g === 'target').length, 1, 'did not retry a checkpoint');
  assert.equal(sweepHealth(r.error).state, 'needs-login');
});

test('a timeout is not retried', async () => {
  // It genuinely did not load; a second 30s wait mostly costs the accounts
  // queued behind this one.
  const page = fakePage({
    gotoResults: [new Error('Navigation timeout of 30000 ms exceeded')],
    urls: ['https://www.linkedin.com/mynetwork/invite-connect/connections/'],
  });
  const r = await bulkCheckConnections(page, 'https://sheet', '', 'cindy');
  assert.equal(page.gotos.filter((g) => g === 'target').length, 1);
  assert.match(r.error, /navigation-failed: Navigation timeout/);
});

test('a tab location never carries a word the classifiers match on', () => {
  // LinkedIn's connections URL contains "network", which magellan-diagnose
  // rule 73 matches. Pasting the raw path reclassified unrelated failures.
  for (const url of [
    'https://www.linkedin.com/mynetwork/invite-connect/connections/',
    'https://www.linkedin.com/mynetwork/grow/',
  ]) {
    assert.doesNotMatch(describeTabLocation(url), /network/i, `leaks "network": ${url}`);
  }
});

test('describeTabLocation names the places that matter', () => {
  assert.equal(describeTabLocation('https://www.linkedin.com/mynetwork/invite-connect/connections/'), 'the connections page');
  assert.equal(describeTabLocation('https://www.linkedin.com/checkpoint/challenge/x'), 'a security checkpoint');
  assert.equal(describeTabLocation('https://www.linkedin.com/uas/login'), 'the sign-in page');
  assert.equal(describeTabLocation('https://www.linkedin.com/feed/'), 'the feed');
  assert.equal(describeTabLocation('about:blank'), 'a blank page');
  assert.equal(describeTabLocation(''), 'a blank page');
});

test('every error shape still reaches the state the card shows', () => {
  // Both classifiers key on these strings by regex, and diagnose's rules are
  // order-sensitive. Pin the routing so a reworded message fails here instead
  // of quietly telling an operator the wrong thing.
  const rows = [
    ['read',   'no-csrf (tab was on the connections page)',                       'needs-login',  'not_logged_in'],
    ['read',   'no-csrf (tab was on a security checkpoint)',                      'needs-login',  'not_logged_in'],
    ['read',   'http-429 (page 1, 0 collected, tab was on the connections page)', 'rate-limited', 'rate_limited'],
    ['read',   'http-999 (page 1, 0 collected, tab was on the connections page)', 'rate-limited', 'linkedin_blocked'],
    ['launch', 'navigation-failed: net::ERR_ABORTED (tab was on the feed)',       'cannot-open',  'launch_timeout'],
    ['launch', 'session-expired (redirected to https://www.linkedin.com/checkpoint/challenge/x)', 'needs-login', 'not_logged_in'],
    // the shapes that existed before this change must be untouched
    ['read',   'no-csrf',                                                          'needs-login',  'not_logged_in'],
    ['read',   'http-429',                                                         'rate-limited', 'rate_limited'],
    ['launch', 'navigation-failed: Navigation timeout of 30000 ms exceeded',       'cannot-open',  'launch_timeout'],
  ];
  for (const [phase, msg, wantState, wantCode] of rows) {
    assert.equal(sweepHealth(msg).state, wantState, `sweepHealth: ${msg}`);
    assert.equal(diagnose(`Could not read connections: ${msg}`, { phase }).code, wantCode, `diagnose(${phase}): ${msg}`);
  }
});
