import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMaturingCampaigns } from '../public/js/mature-profile-board.mjs';
test('maturing runs are separate without duplicating or moving drafts',()=>{
  const items=[{id:'regular',mode:'connect_only',bucket:'running'},{id:'mature',mode:'mature_profile',bucket:'running'},{id:'draft',mode:'mature_profile',bucket:'draft'},{id:'saved',mode:'mature_profile',bucket:'saved'},{id:'paused',mode:'mature_profile',bucket:'running',paused:true}];
  const {regular,maturing}=splitMaturingCampaigns(items);
  assert.deepEqual(regular.map(x=>x.id),['regular','draft','saved']);assert.deepEqual(maturing.map(x=>x.id),['mature','paused']);
  assert.equal(new Set([...regular,...maturing].map(x=>x.id)).size,items.length);
});
