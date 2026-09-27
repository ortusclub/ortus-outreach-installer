import test from 'node:test';
import assert from 'node:assert/strict';
import { hasLocalBrowserSelection, assertGoLoginOnly } from '../src/gologin-only.js';
import { launchLocalBrowser } from '../src/local-launcher.js';
test('legacy sender, primary and batch selections are rejected', () => {
 for (const input of [{profileIds:['real','local-browser']}, {templates:{primarySource:'local-browser'}}, {pairs:[{profileId:'local-browser'}]}, {sender:'local-browser'}]) {
  assert.equal(hasLocalBrowserSelection(input),true);
  assert.throws(()=>assertGoLoginOnly(input), /Select a GoLogin profile/);
 }
});
test('GoLogin profiles, campaign text and local execution target remain valid', () => {
 assert.doesNotThrow(()=>assertGoLoginOnly({profileIds:['gl-id'],templates:{primarySource:'gl-primary',body:'local-browser'},runTarget:'local'}));
});
test('old background tasks cannot launch Chrome even with a visible request', async () => {
 await assert.rejects(launchLocalBrowser({visible:true}), /no longer supported/);
});
