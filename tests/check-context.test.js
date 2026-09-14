import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { checkContext } from '../public/js/check-context.mjs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const pillSource = app.slice(app.indexOf('function _stageAcctPill('), app.indexOf('function _stageDrawerHtml('));
function pill(account) {
  return vm.runInNewContext(pillSource + '\n_stageAcctPill(account, false);', {
    account, _acctLabel: () => 'Sender', acctPillCount: () => '12/50',
    _fgCredits: () => null, _benchWord: () => '', recoveryAction: () => null, escHtml: String,
  });
}

test('weekly limit and primary connection status remain visible together', () => {
  const html = pill({ profileId: 'sender', weeklyCap: true, primaryConnected: false });
  assert.match(html, /Weekly cap/);
  assert.match(html, /Not connected to primary/);
  assert.match(html, /cap-badge bad/);
});

test('primary pending and unverified observations are not labelled disconnected', () => {
  assert.match(pill({ primaryConnected: false, primaryState: 'pending' }), /Primary invite pending/);
  assert.match(pill({ primaryConnected: false, primaryState: 'unverified' }), /Primary connection unverified/);
  assert.doesNotMatch(pill({ primaryConnected: null }), /Not connected to primary/);
});

test('check freezes the newly selected accounts and primary before asynchronous work', () => {
  const config = { sheetUrl: 'sheet-new', mode: 'connect_and_introduce',
    profileIds: ['new-account'], templates: { primaryName: 'New primary', primaryUrl: 'new-primary' } };
  const body = checkContext(config);
  config.profileIds[0] = 'previous-account';
  config.templates.primaryName = 'Previous primary';
  assert.deepEqual(body.profileIds, ['new-account']);
  assert.equal(body.primaryName, 'New primary');
  assert.equal(body.explicitCheckContext, true);
});

test('empty selection rejects instead of silently checking a previous campaign or sheet senders', () => {
  assert.throws(() => checkContext({ sheetUrl: 'sheet', profileIds: [] }), /Select accounts/);
  assert.equal(checkContext({ sheetUrl: 'sheet' }, true).allSenders, true);
});

test('blank primary and disabled auto-accept are explicit values', () => {
  const body = checkContext({ sheetUrl: 'sheet', profileIds: ['new-account'], mode: 'connect_only' });
  assert.equal(body.primaryName, '');
  assert.equal(body.primarySource, '');
  assert.equal(body.autoAcceptPrimary, false);
});

test('server keeps a blank explicit primary instead of replacing it with the old local primary', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = src.indexOf('const _reqTemplates =', src.indexOf("app.post('/api/bulk-check-now'"));
  const end = src.indexOf('// v2.59.2:', start);
  const context = {
    explicitContext: true, primaryName: '', primaryIntroBody: '', primaryUrl: '', introTitle: '',
    autoAcceptPrimary: false, primarySource: '',
    checkFallback: { templates: {} },
    campaign: { templates: { primaryName: 'WRONG PRIMARY', primaryIntroBody: 'OLD INTRO' } },
  };
  const result = vm.runInNewContext(src.slice(start, end) + '\n_effectiveTemplates;', context);
  assert.equal(result.primaryName, '');
  assert.equal(result.primaryIntroBody, '');
  assert.equal(result.autoAcceptPrimary, false);
});
