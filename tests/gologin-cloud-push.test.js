import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pushSavedGoLoginToken } from '../src/gologin-cloud-push.js';
const input = { workspace: 'linkedvelocity', operatorEmail: 'operator@example.com' };
const deps = (fetch) => ({ credentialFields: () => [{ id: 'linkedvelocity' }], tokenForAccount: () => 'saved-token',
  resolveEngine: () => ({ url: 'https://engine.example', token: 'engine-auth', environment: 'production' }), fetch });

test('a signed-in non-admin can push the saved workspace credential', async () => {
  const result = await pushSavedGoLoginToken(input, deps(async (url, options) => {
    assert.equal(url, 'https://engine.example/api/gologin-token');
    assert.equal(options.headers['x-operator'], input.operatorEmail);
    assert.deepEqual(JSON.parse(options.body), { workspace: 'linkedvelocity', token: 'saved-token', confirmReplaceLive: false });
    return { status: 200, json: async () => ({ ok: true, changed: true }) };
  }));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.environment, 'production');
  assert.doesNotMatch(JSON.stringify(result), /saved-token|engine-auth/);
});

test('unauthenticated callers and unknown workspaces never reach the engine', async () => {
  const noRequest = deps(async () => { throw Error('Must not call engine'); });
  assert.equal((await pushSavedGoLoginToken({ ...input, operatorEmail: '' }, noRequest)).status, 401);
  assert.equal((await pushSavedGoLoginToken({ ...input, workspace: 'unknown' }, noRequest)).status, 400);
});

test('engine rejection and replacement confirmation are preserved', async () => {
  for (const reason of ['wrong account', 'dead token', 'needs_confirm']) {
    const result = await pushSavedGoLoginToken(input, deps(async () => ({ status: 400, json: async () => ({ ok: false, reason }) })));
    assert.equal(result.body.ok, false);
    assert.equal(result.body.reason, reason);
  }
  await pushSavedGoLoginToken({ ...input, confirmReplaceLive: true }, deps(async (_url, options) => {
    assert.equal(JSON.parse(options.body).confirmReplaceLive, true);
    return { status: 200, json: async () => ({ ok: true }) };
  }));
});

test('missing saved credentials are reported before any engine call', async () => {
  const options = deps(async () => { throw Error('Must not call engine'); });
  options.tokenForAccount = () => '';
  const result = await pushSavedGoLoginToken(input, options);
  assert.equal(result.status, 400);
  assert.equal(result.body.reason, 'no token saved for this workspace');
});

test('Settings offers Push to engine to non-admins with a saved token', async () => {
  const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function renderCredentialsModal()');
  const end = source.indexOf('\n}', start) + 2;
  const wrap = { innerHTML: '', insertAdjacentHTML(_where, html) { this.innerHTML += html; } };
  const context = vm.createContext({ _viewerIsAdmin: false, _credOthers: [], AbortSignal,
    document: { getElementById: () => wrap }, escHtml: s => String(s),
    fetch: async () => ({ json: async () => ({ credentials: [{ id: 'linkedvelocity', env: 'TOKEN', label: 'Linked Velocity', set: true }] }) }) });
  vm.runInContext(source.slice(start, end), context);
  await context.renderCredentialsModal();
  assert.match(wrap.innerHTML, /Push to engine/);
});
