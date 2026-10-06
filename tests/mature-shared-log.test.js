import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import * as board from '../public/js/mature-profile-board.mjs';

test('editor discovers other accounts during startup, retains entries on failures, and rejects stale polls', async () => {
  const source = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const box = { innerHTML: '', scrollHeight: 100, scrollTop: 100, clientHeight: 100, before() {} };
  const body = { innerHTML: '', querySelector: () => box };
  const host = { hidden: false, isConnected: true, closest: () => null };
  const callbacks = new Map();
  let timer = 0, offline = false;
  const requested = [];
  const context = vm.createContext({
    window: {}, matureResultsLink: () => ({url:'https://docs.google.com/spreadsheets/d/results/edit'}), pinRecentLog() {}, ...board, matureLogClock: board.logClock, escHtml: String,
    document: { createElement: () => ({ className: '', innerHTML: '' }), getElementById: id => id === 'mature-live' ? host : id === 'mature-live-body' ? body : null },
    sessionStorage: { getItem: () => null, setItem() {} },
    location: { hash: '#/new' },
    setInterval: fn => { callbacks.set(++timer, fn); return timer; },
    clearInterval: id => callbacks.delete(id),
    _mapLimit: (items, limit, fn) => Promise.all(items.map(fn)), CLOUD_FANOUT_LIMIT: 4,
    fetch: async url => {
      requested.push(url);
      if (offline) throw new Error('offline');
      return { json: async () => url.endsWith('cloud-list')
        ? { campaigns: [{ id: 'a', config: { matureWarm: true } }, { id: 'b', config: { matureWarm: true } }, { id: 'ordinary', config: {} }] }
        : { campaign: { name: url.endsWith('/a') ? 'Pauline' : 'Riccardo', status: 'running', config: {} }, monitorLog: [{ t: 10, line: 'Browser ready' }] } };
    },
  });
  vm.runInContext(source.slice(source.indexOf('let _matureLogHistory ='), source.indexOf('let _maturingLogHtml =')) + '\n' + source.slice(source.indexOf('let _matureLiveTimer ='), source.indexOf('// Start a Mature Profile plan.')), context);
  vm.runInContext("_renderMatureLaunchLog('New account', [{t: 20, text: 'New account · start — Saving'}], 'Starting')", context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(body.innerHTML, /Maturing log · all accounts/);
  assert.match(body.innerHTML, /openMaturingWebWorkbook/);
  assert.match(body.innerHTML, /Google Sheets/);
  assert.match(body.innerHTML, /spreadsheets\/d\/results/);
  assert.match(body.innerHTML, /Pauline · warm/);
  assert.match(body.innerHTML, /Riccardo · warm/);
  assert.match(body.innerHTML, /New account · start/);
  assert.ok(!requested.some(url => url.endsWith('/ordinary')));
  vm.runInContext("_renderMatureLaunchLog('Another', [{t: 30, text: 'Another · start — Saving'}], 'Starting')", context);
  assert.match(box.innerHTML, /Pauline/);
  assert.match(box.innerHTML, /New account/);
  assert.equal(callbacks.size, 1);
  offline = true;
  await [...callbacks.values()][0]();
  assert.match(box.innerHTML, /Pauline/);
  assert.match(box.innerHTML, /Another/);
  const oldTick = [...callbacks.values()][0];
  vm.runInContext('stopMatureInlineLive()', context);
  const count = requested.length;
  await oldTick();
  assert.equal(requested.length, count);
});
