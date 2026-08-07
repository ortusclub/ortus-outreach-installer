// tests/fg-master-invited-urls.test.js
// Invited write-back must carry the LinkedIn URL, not just the Member ID: a large
// share of the Connections DB has a null linkedin_membership_id, and those people
// can only be stamped on FG Master by URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invitedWritebackFromLeads } from '../src/connections/fg-cloud-launch.js';

const record = {
  perAccount: [{ profileId: 'pid_ada', account: 'ada@ortus.example', operator: 'ada@ortus.example', rowsByUrl: { 'https://linkedin.com/in/bo': '', 'https://linkedin.com/in/cy': '777' } }],
  month: '2026-08',
};

test('invitedWritebackFromLeads carries { memberId, url } per invited lead', () => {
  const groups = invitedWritebackFromLeads([
    { leadUrl: 'https://linkedin.com/in/bo', account: 'pid_ada', status: 'sent', stage: 'Invited' },
    { leadUrl: 'https://linkedin.com/in/cy', account: 'pid_ada', status: 'sent', stage: 'Invited' },
  ], record);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].invited, [
    { memberId: '', url: 'https://linkedin.com/in/bo' },
    { memberId: '777', url: 'https://linkedin.com/in/cy' },
  ]);
});
