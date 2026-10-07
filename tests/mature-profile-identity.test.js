import test from 'node:test';
import assert from 'node:assert/strict';
import {matureProfileIdentity as lookup} from '../public/js/mature-profile-identity.mjs';
const row={email:'riccardo@ortus.solutions','First Name':'Riccardo','Last Name':'Rossi','LinkedIn URL':'https://www.linkedin.com/in/riccardo'};
test('exact profile email resolves raw SoO name and URL headers',()=>assert.deepEqual(lookup({name:'RICCARDO@ortus.solutions'},[row]),{name:'Riccardo Rossi',linkedinUrl:row['LinkedIn URL'],active:false,restricted:false}));
test('ambiguous and partial email matches are never guessed',()=>{assert.equal(lookup({name:'riccardo'},[row]),null);assert.equal(lookup({name:row.email},[row,row]),null)});
test('invalid URL is left empty',()=>assert.equal(lookup({name:row.email},[{...row,'LinkedIn URL':'https://example.com'}]).linkedinUrl,''));

import { matureCampaignName } from '../public/js/mature-profile-identity.mjs';
test('a maturing campaign is named after the login email that names the profile', () => {
  assert.equal(matureCampaignName({ id: 'p1', name: 'Riccardo@Ortus.Solutions' }), 'riccardo@ortus.solutions');
  assert.equal(matureCampaignName({ id: 'p1', name: 'LV 12 - dee@klabber.co (US)' }), 'dee@klabber.co');
  // No email in the profile name: fall back to the profile name itself.
  assert.equal(matureCampaignName({ id: 'p1', name: 'Spare profile 7' }), 'Spare profile 7');
  assert.equal(matureCampaignName(null), '');
});
test('the sign-in email wins over a personal address', () => {
  // The recorded login email is used even when the profile is named otherwise.
  assert.equal(matureCampaignName({ id: 'p1', name: 'jane.doe@gmail.com' }, 'Jane.Doe@klabber.co'), 'jane.doe@klabber.co');
  // With no recorded login email, a company mailbox beats Gmail/Yahoo in the name.
  assert.equal(matureCampaignName({ id: 'p1', name: 'jane@yahoo.com / jane.doe@lotuspost.fyi' }), 'jane.doe@lotuspost.fyi');
  // A personal address is still better than nothing.
  assert.equal(matureCampaignName({ id: 'p1', name: 'jane@gmail.com' }), 'jane@gmail.com');
});
