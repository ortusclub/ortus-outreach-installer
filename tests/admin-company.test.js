import test from 'node:test';
import assert from 'node:assert/strict';
import { emailCompany, outreachBrand, sameCompanyCampaign } from '../public/js/company-access.mjs';
import { scopeAdminSources, scopeBasicsSchedules } from '../src/admin-company.js';
import { buildAdminOverview } from '../src/admin-campaigns.js';
import { canAccessSavedCampaign } from '../src/campaign-visibility.js';

test('login company uses exact domains and maps to the three requested names', () => {
  for (const [email, title] of [['SAM@ORTUSCLUB.COM', 'Ortus Outreach'], ['info@linkedvelocity.com', 'Linked Velocity Outreach'], ['info@apexstrategy.io', 'Apex Outreach']]) {
    assert.equal(outreachBrand(email), title);
    assert(emailCompany(email));
  }
  for (const email of ['', 'sam@ortusclub.com.evil', 'sam@evilortusclub.com', 'sam@@ortusclub.com', 'sam@other.com']) assert.equal(emailCompany(email), '');
});

test('company scope uses the creator, never the target account or campaign name', () => {
  assert(sameCompanyCampaign({owner:'staff@linkedvelocity.com',name:'mara@ortusclub.com'}, 'info@linkedvelocity.com'));
  assert(!sameCompanyCampaign({owner:'staff@linkedvelocity.com',name:'mara@ortusclub.com'}, 'sam@ortusclub.com'));
  assert(!sameCompanyCampaign({name:'sam@ortusclub.com',profileIds:['sam@ortusclub.com']}, 'sam@ortusclub.com'));
  assert(!canAccessSavedCampaign({owner:'sam@ortusclub.com'}, {admin:true,email:'info@apexstrategy.io'}));
});

test('filter before aggregation: every category, history, schedules and local work stay company-scoped', () => {
  const domains = ['ortusclub.com', 'linkedvelocity.com', 'apexstrategy.io'];
  const records = domains.map((domain, i) => ({id:String(i),name:domain,owner:`staff@${domain}`,status:'scheduled',scheduled_start_at:'2026-12-01T10:00:00Z',cron:'0 9 * * *',enabled:true}));
  const sources = Object.fromEntries(['cloud','history','queue','scrapes','connections','schedules'].map(k => [k, records]));
  sources.local = {...records[0],running:true};
  for (const domain of domains) {
    const email = `admin@${domain}`;
    const scoped = scopeAdminSources(sources, email);
    for (const key of ['cloud','history','queue','scrapes','connections','schedules']) {
      assert.equal(scoped[key].length, 1);
      assert.equal(scoped[key][0].owner, `staff@${domain}`);
    }
    assert.equal(!!scoped.local, domain === 'ortusclub.com');
    const result = buildAdminOverview(scoped);
    assert(result.campaigns.every(c => c.owner === `staff@${domain}`));
    const history = result.campaigns.flatMap(c => c.runs).find(r => r.source === 'history');
    assert.equal(history.historyIndex, domains.indexOf(domain), 'original log index survives filtering');
  }
  assert.equal(scopeAdminSources(sources, '').cloud.length, 0);
});

test('Basics schedules and counts cannot include another company or unowned legacy records', () => {
  const basics = { available:true, scheduled:99, schedules:[
    {id:'one',campaignId:'same',source:'schedule',owner:'sam@ortusclub.com'},
    {id:'two',campaignId:'same',source:'queue',owner:'ej@ortusclub.com'},
    {id:'lv',source:'cloud',owner:'info@linkedvelocity.com'},
    {id:'apex',source:'cloud',owner:'info@apexstrategy.io'},
    {id:'unknown',source:'schedule'},
  ] };
  const ortus = scopeBasicsSchedules(basics, 'sam@ortusclub.com');
  assert.equal(ortus.scheduled, 1); assert.equal(ortus.schedules.length, 2);
  assert.deepEqual(scopeBasicsSchedules(basics, 'info@apexstrategy.io').schedules.map(r=>r.id), ['apex']);
  assert.equal(basics.scheduled,99, 'shared cached input is never modified');
});
