import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

// Point the data dir at a temp folder BEFORE importing the module so its
// dataPath() resolves there.
process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'sched-'));
const mod = await import('../src/post-campaign-bulk-check.js');

test('registerSchedule persists the follow-up + auto-accept config', async () => {
  await mod.registerSchedule({
    sheetId: 'S1', sheetUrl: 'u', profileId: 'p1', profileName: 'patrick.s',
    linkedinColumn: 'LinkedIn', days: 7, mode: 'connect_and_introduce',
    primaryName: 'You', primaryIntroBody: 'intro', primaryUrl: 'https://lnkd/in/you',
    autoAcceptPrimary: true, followUpEnabled: true, followUpBody: 'Hi {first name}',
    followUpDelayMinutes: 15, primarySource: 'profile-sched1',
  });
  const sched = await mod.listSchedule();
  const entry = Object.values(sched).find(e => e.profileId === 'p1');
  assert.equal(entry.autoAcceptPrimary, true);
  assert.equal(entry.followUpEnabled, true);
  assert.equal(entry.followUpBody, 'Hi {first name}');
  assert.equal(entry.followUpDelayMinutes, 15);
  assert.equal(entry.primarySource, 'profile-sched1');
});
