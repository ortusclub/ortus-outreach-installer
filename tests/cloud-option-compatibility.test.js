import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudOptionError } from '../public/js/cloud-option-compatibility.mjs';
test('ordinary cloud launches remain available; unsupported local options are explicit',()=>{
 assert.equal(cloudOptionError({mode:'connect_and_introduce'}),'');
 for(const option of ['stopBeforeWeeklyReset','stopBeforeMonthlyReset','skipIntroductions']) {
  assert.match(cloudOptionError({[option]:true}),/require This machine/);
  assert.equal(cloudOptionError({[option]:false}),'');
 }
});
