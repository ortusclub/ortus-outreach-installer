import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { maturingRowState, groupMaturingAccounts } from '../public/js/mature-profile-board.mjs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const control = source.slice(source.indexOf('window.controlMaturingPlan ='), source.indexOf('function _maturingListHtml'));
function harness(request) {
  const pending = new Set(), accepted = new Set(), toasts = [];
  const context = { window: {}, appConfirm: async () => true, _stoppingCloudIds: pending, _maturingStopsAccepted: accepted,
    _markCloudStopping: (id, on) => on ? pending.add(id) : pending.delete(id), renderCampaignsBoard() {},
    _cloudMutationRequest: request, _cloudDetailCache: new Map(), _pushCloudEvent() {},
    showCampaignToast: text => toasts.push(text), _forceCloudItemsAfterAction: async () => {} };
  vm.runInNewContext(control, context);
  return { ...context, pending, accepted, toasts };
}
test('stop marks both stages before the first network response and retains feedback until confirmation', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const button = {};
  const running = h.window.controlMaturingPlan('warm,cold', 'stop', button);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...h.pending], ['warm', 'cold']);
  assert.equal(button.textContent, 'Stopping…');
  assert.equal(button.disabled, true);
  finish({});
  await new Promise(resolve => setImmediate(resolve));
  finish({});
  await running;
  assert.deepEqual([...h.accepted], ['warm', 'cold']);
  assert.equal(h.pending.size, 2);
  assert.match(h.toasts[0], /waiting.*confirm/);
});
test('a rejected stop releases feedback so the operator can retry', async () => {
  const h = harness(async () => { throw Error('Engine unavailable'); });
  await h.window.controlMaturingPlan('warm', 'stop', {});
  assert.equal(h.pending.size, 0);
  assert.match(h.toasts[0], /Engine unavailable/);
});
test('stopping wins over attention and an active sibling; terminal state ends it', () => {
  const warm = {id:'warm',name:'Account',bucket:'running',stopping:true,needsReview:true};
  assert.equal(maturingRowState(warm).label, 'Stopping…');
  assert.equal(groupMaturingAccounts([warm,{name:'Account · Cold',matureKind:'cold',bucket:'running',needsReview:true}])[0].state.label,'Stopping…');
  assert.equal(maturingRowState({...warm,bucket:'done',needsReview:false,bad:true}).label,'Stopped');
});
test('a launching draft shows Starting and disables actions across board redraws', () => {
  const code = source.slice(source.indexOf('const _startingMaturePlans'),source.indexOf('function maturingControlButtons'));
  const h = {escHtml: String, V3_SVG_TRASH:'delete'};
  vm.createContext(h);
  vm.runInContext(code + '\n_startingMaturePlans.add("Amit"); globalThis.draw = _maturingPlainRow;', h);
  const html = h.draw({name:'Amit',state:'Draft',open:'open()',del:'delete()'});
  assert.match(html,/Starting…/); assert.doesNotMatch(html,/>Draft</);
  assert.equal((html.match(/disabled/g)||[]).length,2);
  assert.match(h.draw({name:'Other',state:'Draft'}),/>Draft</);
});
