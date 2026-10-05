import test from 'node:test';
import assert from 'node:assert/strict';
import {matureProfileIdentity as lookup} from '../public/js/mature-profile-identity.mjs';
const row={email:'riccardo@ortus.solutions','First Name':'Riccardo','Last Name':'Rossi','LinkedIn URL':'https://www.linkedin.com/in/riccardo'};
test('exact profile email resolves raw SoO name and URL headers',()=>assert.deepEqual(lookup({name:'RICCARDO@ortus.solutions'},[row]),{name:'Riccardo Rossi',linkedinUrl:row['LinkedIn URL']}));
test('ambiguous and partial email matches are never guessed',()=>{assert.equal(lookup({name:'riccardo'},[row]),null);assert.equal(lookup({name:row.email},[row,row]),null)});
test('invalid URL is left empty',()=>assert.equal(lookup({name:row.email},[{...row,'LinkedIn URL':'https://example.com'}]).linkedinUrl,''));
