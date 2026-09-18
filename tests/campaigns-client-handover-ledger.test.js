import test from 'node:test';
import assert from 'node:assert/strict';
import { getCloudCampaignLeadsAll } from '../src/campaigns-client.js';

test('handover reads every VM lead, including a held lead beyond the card limit', async () => {
  const source = Array.from({ length: 2001 }, (_, n) => ({ id: n + 1, status: n === 2000 ? 'needs_review' : 'pending' }));
  const calls = [];
  const result = await getCloudCampaignLeadsAll('campaign-1', { requestPage: async (_method, path) => {
    const { searchParams } = new URL(path, 'https://engine.test');
    const offset = Number(searchParams.get('offset'));
    calls.push(offset);
    return { total: source.length, leads: source.slice(offset, offset + 2000) };
  } });
  assert.deepEqual(calls, [0, 2000]);
  assert.equal(result.leads.length, 2001);
  assert.equal(result.leads.at(-1).status, 'needs_review');
});

test('handover refuses an incomplete or changing VM ledger', async () => {
  const first = Array.from({ length: 2000 }, (_, n) => ({ id: n + 1 }));
  const result = await getCloudCampaignLeadsAll('campaign-1', { requestPage: async (_method, path) =>
    path.includes('offset=0') ? { total: 2001, leads: first } : { total: 2001, leads: [] } });
  assert.match(result.error, /could not be read completely|changed or ended/i);
});
