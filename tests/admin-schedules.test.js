import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAdminOverview } from '../src/admin-campaigns.js';
import { readBasicsSchedules, scheduledCampaign } from '../src/basics-schedules.js';

test('scheduled counts distinguish dated starts and daily resumptions from queues and paused runs', () => {
  const now = new Date(2026, 9, 9, 12);
  const result = buildAdminOverview({ now, cloud: [
    { id: 'scheduled', status: 'scheduled', scheduled_start_at: '2026-10-10T10:00:00Z' },
    { id: 'daily', status: 'waiting_daily_reset', maturing: true },
    { id: 'paused', status: 'paused', scheduled_start_at: '2026-10-10T10:00:00Z' },
    { id: 'queue', status: 'queued' },
    { id: 'done', status: 'done', scheduled_start_at: '2026-10-01T10:00:00Z' },
  ], queue: [
    { id: 'dated', campaignId: 'same', scheduledAt: '2026-10-10T11:00:00Z' },
    { id: 'undated', config: { mode: 'connect_only' } },
  ], schedules: [
    { id: 's1', campaignId: 'same', enabled: true, cron: '0 9 * * 1-5' },
    { id: 'off', enabled: false, cron: '0 9 * * *' },
    { id: 'sn', enabled: true, cron: '0 9 * * *', mode: 'sales_nav_scrape' },
    { id: 'mat', enabled: true, cron: '0 9 * * *', launchBody: { mode: 'mature_profile' } },
  ] });
  const counts = Object.fromEntries(result.categories.map(c => [c.id, c.scheduled]));
  assert.deepEqual(counts, { outreach: 2, maturing: 2, salesnav: 1, connections: 0 });
  assert.equal(result.campaigns.find(c => c.id === 'outreach:same').runs.length, 2);
  assert.equal(result.campaigns.find(c => c.id === 'outreach:same').hasRun, false);
  assert.equal(scheduledCampaign({status:'running', next_check_at:'2026-10-10'}), null, 'monitoring checks are not campaign starts');
});

test('Basics reads saved local schedules and exact cloud launch IDs without changing its files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'basics-admin-'));
  try {
    const values = {
      'schedules.json': [{ id: 's', campaignId: 'p', name: 'Basics scheduled', cron: '0 9 * * *', createdBy: 'owner@example.com' }, { id: 'off', enabled: false, cron: '0 9 * * *' }],
      'queued-campaigns.json': [{ id: 'q', campaignId: 'p', scheduledAt: '2026-10-10T09:00:00Z' }, { id: 'q2' }],
      'cloud-launch-configs.json': { known: { name: 'Saved Basics run', config: { secret: 'never return this' } } },
    };
    for (const [name, value] of Object.entries(values)) writeFileSync(join(directory, name), JSON.stringify(value));
    const result = await readBasicsSchedules([
      { id: 'known', name: 'Basics in cloud', owner: 'other@example.com', status: 'scheduled', scheduled_start_at: '2026-10-10T10:00:00Z' },
      { id: 'unmatched', name: 'Basics in cloud', status: 'scheduled' },
    ], { directory, now: new Date(2026, 9, 9, 12) });
    assert.equal(result.scheduled, 2, 'same campaign with two local schedule entries is counted once');
    assert.equal(result.schedules.length, 3);
    assert.equal(result.schedules[0].owner, 'owner@example.com');
    assert.deepEqual(result.knownCloudIds, ['known']);
    assert(!JSON.stringify(result).includes('never return this'));
    for (const [name, value] of Object.entries(values)) assert.equal(readFileSync(join(directory, name), 'utf8'), JSON.stringify(value));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Basics distinguishes missing data from corrupt or unreadable schedule records', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'basics-missing-'));
  try {
    assert.equal((await readBasicsSchedules([], { directory: join(directory, 'absent') })).available, false);
    assert.equal((await readBasicsSchedules([], { directory })).scheduled, 0);
    writeFileSync(join(directory, 'schedules.json'), '{broken');
    writeFileSync(join(directory, 'cloud-launch-configs.json'), 'null');
    const result = await readBasicsSchedules([], { directory });
    assert.equal(result.warnings.length, 2);
    assert.deepEqual(result.knownCloudIds, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
