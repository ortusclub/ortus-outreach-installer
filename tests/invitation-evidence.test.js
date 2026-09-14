import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { invitationRecipientMatches, attachVoyagerInvitationCapture, inspectRejectedInvitation } from '../src/linkedin/invitation-evidence.js';
const member = 'ACoAA1234567';
const identity = { memberUrn: `urn:li:fsd_profile:${member}` };
const payload = id => JSON.stringify({ variables: { invitee: { inviteeUnion: { memberProfile: `urn:li:fsd_profile:${id}` } } } });
const endpoint = 'https://www.linkedin.com/voyager/api/graphql?queryId=voyagerRelationshipsDashMemberRelationships.InvitationCreationResult';
function fixture() {
  const page = new EventEmitter(), frame = {};
  page.url = () => 'https://www.linkedin.com/in/recipient'; page.mainFrame = () => frame;
  const request = (id = member, method = 'POST') => ({ url: () => endpoint, method: () => method, frame: () => frame, postData: () => payload(id) });
  const response = (req, status = 200, urn = 'urn:li:invitation:123') => ({ request: () => req, status: () => status, json: async () => ({ data: { value: { invitationUrn: urn } } }) });
  return { page, request, response };
}
test('recipient matching rejects sender-only, mixed, unknown and malformed payloads', () => {
  assert.equal(invitationRecipientMatches(payload(member), identity), true);
  assert.equal(invitationRecipientMatches(payload('ACoAA7654321'), identity), false);
  assert.equal(invitationRecipientMatches({ sender: identity.memberUrn }, identity), false);
  assert.equal(invitationRecipientMatches({ invitees: [identity.memberUrn, 'urn:li:fsd_profile:ACoAA7654321'] }, identity), false);
  assert.equal(invitationRecipientMatches('not JSON', identity), false);
});
test('only matching POST observed in this attempt can confirm a send', async () => {
  const { page, request, response } = fixture(), capture = attachVoyagerInvitationCapture(page, identity);
  const stale = request(); page.emit('response', response(stale));
  for (const req of [request('ACoAA7654321'), request(member, 'GET')]) { page.emit('request', req); page.emit('response', response(req, 429)); }
  await new Promise(r => setImmediate(r)); assert.equal(capture.fired(), false);
  const req = request(); page.emit('request', req); page.emit('response', response(req));
  assert.equal((await capture.waitFor(20)).ok, true);
  page.emit('response', response(req, 429)); await new Promise(r => setImmediate(r));
  assert.equal((await capture.waitFor(20)).status, 200);
  capture.detach(); assert.equal(page.listenerCount('request'), 0); assert.equal(page.listenerCount('response'), 0);
});
test('a bare 2xx and a navigated tab are not accepted as successful sends', async () => {
  const { page, request, response } = fixture(), capture = attachVoyagerInvitationCapture(page, identity);
  const req = request(); page.emit('request', req); page.emit('response', response(req, 200, null));
  assert.equal((await capture.waitFor(20)).ok, false); capture.detach();
  const next = attachVoyagerInvitationCapture(page, identity), req2 = request(); page.emit('request', req2);
  page.url = () => 'https://www.linkedin.com/in/other'; page.emit('response', response(req2));
  assert.equal(await next.waitFor(5), null); next.detach();
});
test('post-rejection observation is bounded and never navigates or clicks', async () => {
  let reads = 0;
  const page = { url: () => 'https://www.linkedin.com/in/recipient', isClosed: () => false,
    evaluate: async () => { reads++; return reads === 3; } };
  assert.equal(await inspectRejectedInvitation(page, { intervalMs: 0 }), 'pending_observed');
  assert.equal(reads, 3);
  page.isClosed = () => true;
  assert.equal(await inspectRejectedInvitation(page, { intervalMs: 0 }), 'unknown');
});
