import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sameCampaign } from '../public/js/campaign-lifecycle.mjs';
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function syncLiveStatusVisibility()');
const source = app.slice(start, app.indexOf("if (typeof window !== 'undefined') window.syncLiveStatusVisibility", start));
function visibility(draftName, forced = false, selected = null) {
  const section = { style: {}, classList: { remove() {} } };
  const nav = { style: {} };
  const fields = { 'nav-status': section, 'campaign-name-input': { value: draftName }, 'campaign-mode': { value: 'connect_and_introduce' } };
  const context = vm.createContext({
    sameCampaign,
    document: { getElementById: id => fields[id], querySelector: () => nav },
    location: { hash: '#/new' }, isOnNewCampaignView: () => true,
    __cockpit: { name: 'Sam', running: false, state: 'done', hasLogs: true, endNotice: {} },
    _viewingCloudId: null, _viewingLocalCampaign: selected, window: {}, liveStatusForcedOpen: forced, _whBusy: false,
    placeLiveCard() {}, _launchConsoleState: null, cloudLaunchStatus: () => null,
  });
  vm.runInContext(source + ';syncLiveStatusVisibility();', context);
  return section.style.display;
}
test('duplicate does not inherit the stopped source status, even with stale forced-open flag', () => {
  assert.equal(visibility('Sam II'), 'none');
  assert.equal(visibility('Sam II', true), 'none');
  assert.equal(visibility(''), 'none');
});
test('the original stopped campaign retains its own log', () => {
  assert.equal(visibility('Sam'), '');
});

test('explicitly reopening a past campaign shows its history while another singleton is idle', () => {
  assert.equal(visibility('Past campaign', true, { name: 'Past campaign', status: { name: 'Past campaign', hasRun: true, logs: ['Historic event'] } }), '');
  assert.equal(visibility('A new duplicate', true, { name: 'Past campaign', status: { name: 'Past campaign', hasRun: true, logs: ['Historic event'] } }), 'none');
});
