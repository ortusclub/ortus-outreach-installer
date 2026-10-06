import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { writeMatureTab } from '../src/connections/drive-sync.js';

test('an incomplete confirmation is retryable, with the same payload', async () => {
  const original = globalThis.fetch, calls=[];
  globalThis.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); return {text:async()=>JSON.stringify(calls.length===1 ? {ok:true} : {ok:true,url:'https://docs.google.com/spreadsheets/d/id/edit#gid=1',planRows:[]})}; };
  try {
    const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
    const from=source.indexOf('async function createWarmSheet('), to=source.indexOf('// Run the cloud launch pipeline',from);
    const context=vm.createContext({createWorkbookTab(){},setTimeout:fn=>fn(),writeMatureTab});
    vm.runInContext(source.slice(from,to),context);
    await vm.runInContext("createWarmSheet({spreadsheetId:'id',tabName:'a_cold',header:['LinkedIn URL'],rows:[],reuseExistingPlan:false},null,writeMatureTab)",context);
    assert.equal(calls.length,2);
    assert.deepEqual(calls[0],calls[1]);
  } finally {globalThis.fetch=original;}
});

test('retrying a saved random plan reuses original recipients and statuses without appending', async () => {
  const original=globalThis.fetch;const writes=[];
  globalThis.fetch=async (url,options) => {
    if(options?.method==='POST') {writes.push(JSON.parse(options.body));return {text:async()=>JSON.stringify({ok:true,url:'https://docs.google.com/spreadsheets/d/id/edit#gid=42',gid:42})};}
    return {ok:true,status:200,text:async()=> 'Type,LinkedIn URL,Planned Day,Connection Request Status\nCold,https://linkedin.com/in/original,8,Connection Request Sent'};
  };
  try {
    const args={spreadsheetId:'id',tabName:'a_cold',header:['Type','LinkedIn URL','Planned Day','Connection Request Status'],rows:[['Cold','https://linkedin.com/in/different',8,'']],reuseExistingPlan:true};
    const result=await writeMatureTab(args);
    assert.equal(result.reused,true);
    assert.equal(result.planRows[0][1],'https://linkedin.com/in/original');
    assert.equal(result.planRows[0][3],'Connection Request Sent');
    assert.deepEqual(writes.map(w=>w.rows),[[]]);
    await assert.rejects(writeMatureTab({...args,rows:[['Cold','https://linkedin.com/in/different',9,'']]}),/different plan/);
    assert.ok(writes.every(w=>w.rows.length===0));
  } finally {globalThis.fetch=original;}
});
