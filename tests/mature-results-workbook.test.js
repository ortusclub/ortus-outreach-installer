import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { matureSheetsWebappUrl } from '../src/sheets-webapp-url.js';

test('development uses the released maturing bridge unless explicitly overridden', () => {
  const original = process.env.MATURE_SHEETS_WEBAPP_URL;
  try {
    delete process.env.MATURE_SHEETS_WEBAPP_URL;
    const bundled = fs.readFileSync(new URL('../build/release.env', import.meta.url), 'utf8').match(/^MATURE_SHEETS_WEBAPP_URL=(.+)$/m)[1].trim();
    assert.equal(matureSheetsWebappUrl(), bundled);
    process.env.MATURE_SHEETS_WEBAPP_URL = ' https://example.test/exec ';
    assert.equal(matureSheetsWebappUrl(), 'https://example.test/exec');
  } finally {
    if (original === undefined) delete process.env.MATURE_SHEETS_WEBAPP_URL;
    else process.env.MATURE_SHEETS_WEBAPP_URL = original;
  }
});

test('a failed workbook write stops instead of creating a separate spreadsheet', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('    let tab = null;', source.indexOf("app.post('/api/mature/start'"));
  const end = source.indexOf('    if (warmOn) {', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const writeMatureTab = () => {};
  const context = vm.createContext({
    createWarmSheet: async (payload, retry, writer) => { calls.push({ payload, writer }); throw new Error('workbook unavailable'); },
    writeMatureTab, warmOn: true, MATURE_RESULTS_SHEET_ID: 'existing-workbook', name: 'Pauline', MATURE_TAB_HEADER: [],
    buildMatureTabRows: () => [], startDate: '2026-10-06', pool: { targets: [] }, warmAmounts: [], coldLeads: [], cold: null,
    checkCancelled() {}, step() {}, console: { warn() {}, log() {} },
  });
  await assert.rejects(vm.runInContext(`(async () => {${source.slice(start, end)}})()`, context), /No campaign was started/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.spreadsheetId, 'existing-workbook');
  assert.equal(calls[0].payload.tabName, 'Pauline_warm');
  assert.equal(calls[0].writer, writeMatureTab);
});

for (const enabled of ['both', 'warm', 'cold']) test(`${enabled}: only enabled connection lists are written and launched`, async()=>{
  const { buildMatureTabRows, MATURE_TAB_HEADER } = await import('../public/js/mature-warm-pool.mjs');
  const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const start=source.indexOf('    let tab = null;',source.indexOf("app.post('/api/mature/start'"));
  const end=source.indexOf("    step('Started. A cloud worker",start);
  const writes=[],launches=[];
  const context=vm.createContext({
    buildMatureTabRows,MATURE_TAB_HEADER,name:'person@example.com',warmOn:enabled!=='cold',warmAmounts:enabled==='cold'?[]:[1,0],
    pool:{targets:[{name:'Warm Person',linkedinUrl:'https://www.linkedin.com/in/warm',profile:'warm@example.com',profileId:'warm-id'}]},
    cold:enabled==='warm'?null:{delayDays:7,amounts:[1,0]},coldLeads:[{name:'Cold Person',linkedinUrl:'https://www.linkedin.com/in/cold'}],
    startDate:'2026-10-06',now:new Date('2026-10-06T09:00:00Z'),planTz:'UTC',localDay:d=>d.toISOString().slice(0,10),
    checkCancelled(){},launched:[],MATURE_RESULTS_SHEET_ID:'workbook',writeMatureTab(){},step(){},console,
    createWarmSheet:async payload=>{writes.push(payload);return {url:`https://example.test/${writes.length}`,gid:writes.length,created:true,added:payload.rows.length,existing:0}},
    matureStartProgress:new Map(),b:{launchId:'launch'},campaignId:'plan',profileId:'profile',plan:{warmPool:'all_available'},maturedAccount:{},req:{},result:{ok:true},
    launchMatureStage:async(req,body)=>{launches.push(body);return {ok:true,id:String(launches.length),leadsAdded:1}},
  });
  await vm.runInContext(`(async()=>{${source.slice(start,end)}})()`,context);
  const kinds=enabled==='both'?['warm','cold']:[enabled];
  assert.deepEqual(writes.map(w=>w.tabName),kinds.map(k=>`person@example.com_${k}`));
  assert.deepEqual(writes.map(w=>w.rows.map(r=>r[0])),kinds.map(k=>[k==='warm'?'Warm':'Cold']));
  assert.deepEqual(launches.map(l=>l.sheetUrl),kinds.map((_,i)=>`https://example.test/${i+1}`));
  if (enabled!=='warm') assert.equal(writes.at(-1).rows[0][5],8);
  assert.deepEqual(Object.keys(context.result.resultsUrls),kinds);
});
