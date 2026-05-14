import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../src/preflight-primary.js';

// Mock verifier — returns whatever is queued per profileName.
function mockVerifier(queue) {
  return async ({ profileName }) => {
    if (!queue.has(profileName)) {
      throw new Error(`unexpected profile: ${profileName}`);
    }
    const item = queue.get(profileName);
    if (item.delayMs) await new Promise(r => setTimeout(r, item.delayMs));
    if (item.throw) throw new Error(item.throw);
    return item.result;
  };
}

test('runPreflight: all profiles pass', async () => {
  const queue = new Map([
    ['a@x.com', { result: { ok: true, canonicalName: 'Sam Ferrer', candidates: [] } }],
    ['b@x.com', { result: { ok: true, canonicalName: 'Sam Ferrer', candidates: [] } }],
  ]);
  const out = await runPreflight({
    sessions: [
      { profileId: 'p1', profileName: 'a@x.com', page: {} },
      { profileId: 'p2', profileName: 'b@x.com', page: {} },
    ],
    primaryName: 'Sam Ferrer',
    primaryUrl: 'https://linkedin.com/in/sam',
    verifier: mockVerifier(queue),
  });
  assert.equal(out.allPassed, true);
  assert.equal(out.results.length, 2);
  assert.equal(out.results.every(r => r.ok), true);
});

test('runPreflight: one profile fails — allPassed false, results include failure detail', async () => {
  const queue = new Map([
    ['a@x.com', { result: { ok: true, canonicalName: 'Sam', candidates: [] } }],
    ['b@x.com', { result: { ok: false, failureType: 'name_mismatch', canonicalName: 'Samuel Ferrer', candidates: [{ text: 'Samuel Ferrer · CEO' }], detail: 'no match' } }],
  ]);
  const out = await runPreflight({
    sessions: [
      { profileId: 'p1', profileName: 'a@x.com', page: {} },
      { profileId: 'p2', profileName: 'b@x.com', page: {} },
    ],
    primaryName: 'Sam Ferrer',
    primaryUrl: 'https://linkedin.com/in/sam',
    verifier: mockVerifier(queue),
  });
  assert.equal(out.allPassed, false);
  const failed = out.results.find(r => r.profileName === 'b@x.com');
  assert.equal(failed.ok, false);
  assert.equal(failed.failureType, 'name_mismatch');
  assert.equal(failed.canonicalName, 'Samuel Ferrer');
});

test('runPreflight: verifier throws — captured as failureType crash', async () => {
  const queue = new Map([
    ['a@x.com', { throw: 'browser crashed' }],
  ]);
  const out = await runPreflight({
    sessions: [{ profileId: 'p1', profileName: 'a@x.com', page: {} }],
    primaryName: 'Sam Ferrer',
    primaryUrl: 'https://linkedin.com/in/sam',
    verifier: mockVerifier(queue),
  });
  assert.equal(out.allPassed, false);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].failureType, 'crash');
  assert.match(out.results[0].detail, /browser crashed/);
});

test('runPreflight: overall timeout — unfinished profiles reported as failureType timeout', async () => {
  const queue = new Map([
    ['fast@x.com', { result: { ok: true, canonicalName: 'X', candidates: [] } }],
    ['slow@x.com', { delayMs: 500, result: { ok: true, canonicalName: 'X', candidates: [] } }],
  ]);
  const out = await runPreflight({
    sessions: [
      { profileId: 'p1', profileName: 'fast@x.com', page: {} },
      { profileId: 'p2', profileName: 'slow@x.com', page: {} },
    ],
    primaryName: 'X',
    primaryUrl: 'u',
    verifier: mockVerifier(queue),
    overallTimeoutMs: 100,
  });
  assert.equal(out.allPassed, false);
  const slow = out.results.find(r => r.profileName === 'slow@x.com');
  assert.equal(slow.ok, false);
  assert.equal(slow.failureType, 'timeout');
});

test('runPreflight: empty sessions list returns allPassed=true', async () => {
  const out = await runPreflight({
    sessions: [],
    primaryName: 'X',
    primaryUrl: 'u',
    verifier: async () => ({ ok: true }),
  });
  assert.equal(out.allPassed, true);
  assert.equal(out.results.length, 0);
});
