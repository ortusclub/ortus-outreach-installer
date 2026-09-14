import test from 'node:test';
import assert from 'node:assert/strict';
import { previewUserDataDir } from '../electron/preview-data-dir.mjs';

test('ordinary launches retain their existing Electron profile', () => {
  assert.equal(previewUserDataDir('/profiles', {}), null);
});
test('explicit PR preview uses a distinct stable profile', () => {
  assert.equal(previewUserDataDir('/profiles', {
    ORTUS_PREVIEW_ISOLATED_DATA: '1', ORTUS_ENGINE_ENVIRONMENT: 'preview', ORTUS_PREVIEW_PR: '19',
  }), '/profiles/Ortus PR-19 Stage3 Preview');
});
test('isolated preview rejects other engines and invalid PR identifiers', () => {
  for (const [environment, pr] of [['dev', '19'], ['production', '19'], ['preview', ''], ['preview', '../19'], ['preview', '0']]) {
    assert.throws(() => previewUserDataDir('/profiles', {
      ORTUS_PREVIEW_ISOLATED_DATA: '1', ORTUS_ENGINE_ENVIRONMENT: environment, ORTUS_PREVIEW_PR: pr,
    }));
  }
});
