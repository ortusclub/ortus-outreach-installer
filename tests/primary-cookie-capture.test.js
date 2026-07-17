import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturePrimaryCookies } from '../src/primary-cookie-capture.js';

function fakePage(cookies) {
  return { async cookies() { return cookies; } };
}

test('captures memberId/publicIdentifier/displayName/cookies from a slug profile URL', async () => {
  const cookies = [{ name: 'li_at', value: 'x' }, { name: 'JSESSIONID', value: 'y' }];
  const deps = { readSelfIdentity: async () => ({ name: 'Jane Doe', profileUrl: 'https://www.linkedin.com/in/Jane-Doe/' }) };
  const cap = await capturePrimaryCookies(fakePage(cookies), deps);
  assert.deepEqual(cap, { memberId: 'jane-doe', publicIdentifier: 'jane-doe', displayName: 'Jane Doe', cookies });
});

test('no li_at cookie (not logged in) → null', async () => {
  const cookies = [{ name: 'JSESSIONID', value: 'y' }];
  const deps = { readSelfIdentity: async () => ({ name: 'Jane Doe', profileUrl: 'https://www.linkedin.com/in/Jane-Doe/' }) };
  const cap = await capturePrimaryCookies(fakePage(cookies), deps);
  assert.equal(cap, null);
});

test('empty profileUrl (no slug) → null', async () => {
  const cookies = [{ name: 'li_at', value: 'x' }];
  const deps = { readSelfIdentity: async () => ({ name: 'Jane Doe', profileUrl: '' }) };
  const cap = await capturePrimaryCookies(fakePage(cookies), deps);
  assert.equal(cap, null);
});

test('readSelfIdentity throwing → null (never throws out of capturePrimaryCookies)', async () => {
  const cookies = [{ name: 'li_at', value: 'x' }];
  const deps = { readSelfIdentity: async () => { throw new Error('nav timeout'); } };
  const cap = await capturePrimaryCookies(fakePage(cookies), deps);
  assert.equal(cap, null);
});
