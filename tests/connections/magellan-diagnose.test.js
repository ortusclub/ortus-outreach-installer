import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, logLine, summarise } from '../../src/connections/magellan-diagnose.js';

// The real error from the first live run. It has to produce an instruction,
// not a stack trace.
test('the GoLogin extension-cache crash is explained in plain words', () => {
  const d = diagnose(new Error('Invalid header: Does not start with Cr24'));
  assert.equal(d.code, 'gologin_extension_cache');
  assert.equal(d.what, 'The browser never opened');
  assert.match(d.fix, /extensions cache/i);
  assert.equal(d.retryable, true);
});

test('a stack trace still matches on the frame that names the cause', () => {
  const d = diagnose(new Error('at crxToZip (extensions-manager.js:324:11)'));
  assert.equal(d.code, 'gologin_extension_cache');
});

test('an expired session is flagged as not-retryable — a human has to sign in', () => {
  const d = diagnose('Could not read connections: no-csrf');
  assert.equal(d.code, 'not_logged_in');
  assert.equal(d.retryable, false);
  assert.match(d.fix, /sign in/i);
});

test('throttling and hard blocks are told apart', () => {
  assert.equal(diagnose('Could not read connections: http-429').code, 'rate_limited');
  assert.equal(diagnose('Could not read connections: http-429').retryable, true);
  assert.equal(diagnose('Could not read connections: http-999').code, 'linkedin_blocked');
  assert.equal(diagnose('Could not read connections: http-999').retryable, false);
});

test('an empty list points at the account before blaming the code', () => {
  const d = diagnose('Could not read connections: empty-after-3-strategies (keys: data, included.len: 0)');
  assert.equal(d.code, 'endpoint_changed');
  assert.match(d.fix, /check it has connections/i);
});

test('closing the browser mid-run is named as such', () => {
  assert.equal(diagnose(new Error('Protocol error: Target closed')).code, 'browser_closed');
});

test('an unrecognised error still yields something actionable, keeping the raw text', () => {
  const d = diagnose(new Error('something nobody predicted'));
  assert.equal(d.code, 'unknown');
  assert.equal(d.raw, 'something nobody predicted');
  assert.match(d.why, /something nobody predicted/);
});

test('the log line names the account, the cause and the fix', () => {
  const line = logLine('antonio@ortusclub.com', diagnose(new Error('Cr24')));
  assert.match(line, /antonio@ortusclub\.com/);
  assert.match(line, /never opened/);
  assert.match(line, /extensions cache/i);
});

// 300 accounts failing for 2 reasons should read as 2 problems, not 300.
test('failures collapse to their causes, biggest first', () => {
  const per = [
    { account: 'a@o.com', total: 10 },
    { account: 'b@o.com', error: 'Cr24', diagnosis: diagnose('Cr24') },
    { account: 'c@o.com', error: 'Cr24', diagnosis: diagnose('Cr24') },
    { account: 'd@o.com', error: 'no-csrf', diagnosis: diagnose('no-csrf') },
  ];
  const s = summarise(per);
  assert.equal(s.length, 2);
  assert.equal(s[0].code, 'gologin_extension_cache');
  assert.equal(s[0].count, 2);
  assert.deepEqual(s[0].accounts, ['b@o.com', 'c@o.com']);
  assert.equal(s[1].code, 'not_logged_in');
});

test('successful accounts never appear in the failure summary', () => {
  assert.deepEqual(summarise([{ account: 'a@o.com', total: 10 }]), []);
});

// The real bug: a Voyager error containing a network-ish word matched the
// GoLogin-unreachable rule, so the operator was told "The browser never opened"
// one line after being told the account had signed in.
test('launch-only causes are never blamed for a failure while reading', () => {
  const d = diagnose(new Error('Could not read connections: network error'), { phase: 'read' });
  assert.notEqual(d.code, 'gologin_unreachable');
  assert.equal(d.what, 'The connections list could not be read');
  assert.match(d.why, /network error/);
});

test('the same error while launching still names GoLogin', () => {
  const d = diagnose(new Error('network error'), { phase: 'launch' });
  assert.equal(d.code, 'gologin_unreachable');
});

// When the explanation is wrong, the raw text is the only thing that says so.
test('the log line always carries the raw error', () => {
  const line = logLine('a@o.com', diagnose(new Error('Cr24 boom'), { phase: 'launch' }));
  assert.match(line, /\[Cr24 boom\]$/);
});

test('the raw error is not repeated when it is already in the words', () => {
  const line = logLine('a@o.com', diagnose(new Error('something nobody predicted')));
  assert.equal((line.match(/something nobody predicted/g) || []).length, 1);
});

// The port in "ECONNREFUSED 127.0.0.1:38657" is the browser's own debugging
// port on this machine, so GoLogin was plainly reachable — it answered.
test('a refused loopback port is the browser dying, not GoLogin being unreachable', () => {
  const d = diagnose(new Error('connect ECONNREFUSED 127.0.0.1:38657'), { phase: 'launch' });
  assert.equal(d.code, 'browser_died_on_start');
  assert.match(d.why, /different GoLogin account/);
});

test('a refused remote host is still GoLogin being unreachable', () => {
  const d = diagnose(new Error('connect ECONNREFUSED 104.18.2.1:443'), { phase: 'launch' });
  assert.equal(d.code, 'gologin_unreachable');
});
