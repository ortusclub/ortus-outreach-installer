import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {matureProfileIdentity} from '../public/js/mature-profile-identity.mjs';
const source=readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function prefillPrimaryContact('),source.indexOf('function filterPrimarySourcePicker()'));
function setup(load=async()=>{}) {
 const fields=Object.fromEntries(['primary-person-name','primary-person-url','primary-source-profile-id','primary-source-soo-status'].map(id=>[id,{value:id==='primary-source-profile-id'?'a':'',dispatchEvent(){}}]));
 const ctx=vm.createContext({document:{getElementById:id=>fields[id]},Event:class{},matureProfileIdentity,sooData:{},_currentWizardName:()=> 'Campaign',_openedCampaignId:'campaign-id',loadSoOStatus:()=>load(ctx,fields),savePrimaryPersonFields(){},refreshPrimarySourceLabels(){}});vm.runInContext(code,ctx);return {ctx,fields};
}
const row={email:'person@example.com','Full Name':'Person Name','LinkedIn URL':'https://www.linkedin.com/in/person'};
test('selection fills both primary fields from SoO',async()=>{const {ctx,fields}=setup();ctx.sooData={person:row};await ctx.prefillPrimaryContact({id:'a',name:row.email});assert.equal(fields['primary-person-name'].value,'Person Name');assert.equal(fields['primary-person-url'].value,row['LinkedIn URL']);});
test('late lookup preserves typing and ignores another selected profile',async()=>{const {ctx,fields}=setup(async(ctx,fields)=>{ctx.sooData={person:row};fields['primary-person-name'].value='My edit';});await ctx.prefillPrimaryContact({id:'a',name:row.email});assert.equal(fields['primary-person-name'].value,'My edit');const other=setup(async(ctx,fields)=>{ctx.sooData={person:row};fields['primary-source-profile-id'].value='b';});await other.ctx.prefillPrimaryContact({id:'a',name:row.email});assert.equal(other.fields['primary-person-url'].value,'');});
