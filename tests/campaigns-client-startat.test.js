// tests/campaigns-client-startat.test.js
//
// "Schedule on the VM" — the wire contract for a scheduled cloud launch. The
// dispatch is an ordinary cloud start plus `startAt`; the ENGINE parks the
// campaign in 'scheduled' and starts it itself at that instant, so this Mac can
// be shut. The engine half (scheduled status, durable start_campaign task, a
// cancelled campaign never resurrected) is covered by
// test-campaign-scheduled-start.js in the engine repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCloudCampaign } from '../src/campaigns-client.js';

const LEADS = [{ leadUrl: 'https://www.linkedin.com/in/lead-one' }];

async function capture(payload) {
  const origFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, opts) => {
    body = opts?.body ? JSON.parse(opts.body) : null;
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'c1', leadsAdded: 1 }) };
  };
  try { await startCloudCampaign(payload); } finally { globalThis.fetch = origFetch; }
  return body;
}

const base = { mode: 'connect_only', name: 'Monday 9am', owner: 'op@ortus.solutions', profileIds: ['gl_a'], leads: LEADS };

test('startAt rides along with the launch', async () => {
  const when = new Date(Date.now() + 3600e3).toISOString();
  const body = await capture({ ...base, startAt: when });
  assert.equal(body.startAt, when);
});

test('the field is OMITTED for an immediate launch', async () => {
  // Absent — not null, not '' — so the engine's `b.startAt ? …` check can never
  // read a falsy value as a date and park the campaign by accident.
  for (const startAt of [undefined, null, '']) {
    const body = await capture({ ...base, startAt });
    assert.equal('startAt' in body, false, `startAt should be absent for ${JSON.stringify(startAt)}`);
  }
});
