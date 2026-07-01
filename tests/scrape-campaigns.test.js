import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setFileForTests, addScrapeCampaign, listScrapeCampaigns,
  getScrapeCampaign, updateScrapeCampaign,
} from '../src/scrape-campaigns.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scpc-')), 'scrape-campaigns.json');
}

test('add persists a record with an id, defaults enabled=true, and createdAt', async () => {
  __setFileForTests(tmpFile());
  const rec = await addScrapeCampaign({
    name: 'APAC_EXPANSION', owner: 'alecx@ortus.solutions',
    sheetUrl: 'https://docs.google.com/x', tabName: 'Results',
    profileIds: ['p1', 'p2'], searchUrls: ['u1', 'u2'],
  });
  assert.ok(rec.id && rec.id.startsWith('sc_'));
  assert.equal(rec.enabled, true);
  assert.equal(typeof rec.createdAt, 'number');
  assert.deepEqual(rec.profileIds, ['p1', 'p2']);
  const all = await listScrapeCampaigns();
  assert.equal(all.length, 1);
  assert.equal(all[0].owner, 'alecx@ortus.solutions');
});

test('get returns the record by id, or null when missing', async () => {
  __setFileForTests(tmpFile());
  const rec = await addScrapeCampaign({ name: 'X', owner: 'a@b', sheetUrl: 's', tabName: 'T', profileIds: [], searchUrls: [] });
  assert.equal((await getScrapeCampaign(rec.id)).name, 'X');
  assert.equal(await getScrapeCampaign('nope'), null);
});

test('update merges only allowed keys and ignores others', async () => {
  __setFileForTests(tmpFile());
  const rec = await addScrapeCampaign({ name: 'X', owner: 'a@b', sheetUrl: 's', tabName: 'T', profileIds: [], searchUrls: [] });
  const upd = await updateScrapeCampaign(rec.id, { enabled: false, owner: 'HACKER' });
  assert.equal(upd.enabled, false);
  assert.equal(upd.owner, 'a@b'); // owner is NOT an allowed patch key
});
