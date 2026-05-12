import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetDataForAction, buildSkipSheetData } from '../src/campaign.js';

// ── connection_sent ──
test('connection_sent: writes Connection Status + mirrors Status + Stage', () => {
  const r = buildSheetDataForAction({
    action: 'connection_sent',
    mode: 'connect_only',
    profileName: 'matt@ortus'
  });
  assert.equal(r.connectionStatus, 'Connection Request Sent');
  assert.equal(r.status, 'Connection Request Sent');
  assert.equal(r.stage, 'Connect Pending');
  assert.equal(r.sender, 'matt@ortus');
});

// ── already_connected ──
test('already_connected: marks Connected + flips connectedAlready', () => {
  const r = buildSheetDataForAction({
    action: 'already_connected',
    mode: 'connect_only',
    profileName: 'sam@ortus'
  });
  assert.equal(r.connectionStatus, 'Already Connected');
  assert.equal(r.cc, 'Connected');
  assert.equal(r.connectedAlready, 'Yes');
  assert.equal(r.stage, 'Connected');
});

// ── connect_and_introduce: connection_sent ──
test('connect_and_introduce: connection_sent writes Connection Status + mirrors Status + Stage', () => {
  const r = buildSheetDataForAction({
    action: 'connection_sent',
    mode: 'connect_and_introduce',
    profileName: 'matt@ortus'
  });
  // Phase 1 of connect_and_introduce is identical to connect_only for the
  // connection_sent stamp: writes Connection Request Status, mirrors Status,
  // marks Stage as Connect Pending.
  assert.equal(r.connectionStatus, 'Connection Request Sent');
  assert.equal(r.status, 'Connection Request Sent');
  assert.equal(r.stage, 'Connect Pending');
  assert.equal(r.sender, 'matt@ortus');
});

test('connect_and_introduce: already_connected stamp', () => {
  const r = buildSheetDataForAction({
    action: 'already_connected',
    mode: 'connect_and_introduce',
    profileName: 'matt@ortus'
  });
  // Already-1st-degree leads in connect_and_introduce still get the
  // Connection Status (request) stamp + Connected flip — auto-intro
  // happens later via the bulk-check trigger, not via this code path.
  assert.equal(r.connectionStatus, 'Already Connected');
  assert.equal(r.cc, 'Connected');
  assert.equal(r.connectedAlready, 'Yes');
  assert.equal(r.stage, 'Connected');
});

// ── message_sent (plain DM) ──
test('message_sent without introMode: writes DM Status', () => {
  const r = buildSheetDataForAction({
    action: 'message_sent',
    mode: 'message_only',
    profileName: 'matt@ortus',
    hyperSent: '=HYPERLINK("x","Sent")',
    introMode: false
  });
  assert.equal(r.dmStatus, 'DM Sent');
  assert.equal(r.introStatus, undefined);
  assert.equal(r.status, 'DM Sent');
  assert.equal(r.stage, 'DM Sent');
  assert.equal(r.message, '=HYPERLINK("x","Sent")');
});

// ── message_sent (intro mode) ──
test('message_sent with introMode + message_only: writes Intro Status', () => {
  const r = buildSheetDataForAction({
    action: 'message_sent',
    mode: 'message_only',
    introMode: true
  });
  assert.equal(r.introStatus, 'IC Sent');
  assert.equal(r.dmStatus, undefined);
  assert.equal(r.status, 'IC Sent');
  assert.equal(r.stage, 'IC Sent');
});

test('message_sent with introMode + introduce_back: writes Intro Status', () => {
  const r = buildSheetDataForAction({
    action: 'message_sent',
    mode: 'introduce_back',
    introMode: true
  });
  assert.equal(r.introStatus, 'IC Sent');
  assert.equal(r.stage, 'IC Sent');
});

// ── op_message_sent ──
test('op_message_sent: writes OP Status, Status mirrors "DM Sent" (legacy)', () => {
  const r = buildSheetDataForAction({
    action: 'op_message_sent',
    mode: 'open_profile_only',
    hyperSent: '=HYPERLINK("x","Sent")'
  });
  assert.equal(r.opStatus, 'OP Sent');
  assert.equal(r.status, 'DM Sent');
  assert.equal(r.stage, 'OP Sent');
  assert.equal(r.op, '=HYPERLINK("x","Sent")');
});

test('op_message_sent inside connect_only with messageOpenProfiles: audit reflects it', () => {
  const r = buildSheetDataForAction({
    action: 'op_message_sent',
    mode: 'connect_only',
    messageOpenProfiles: true
  });
  assert.equal(r.auditAction, 'Open Profile message sent (via connect mode)');
});

// ── inmail_sent ──
test('inmail_sent: writes InM Status + credits note', () => {
  const r = buildSheetDataForAction({
    action: 'inmail_sent',
    mode: 'inmail_only',
    hyperSent: '=HYPERLINK("x","Sent")',
    creditsLeft: 3
  });
  assert.equal(r.inmStatus, 'InM Sent');
  assert.equal(r.status, 'Done');
  assert.equal(r.stage, 'InM Sent');
  assert.equal(r.auditNotes, 'InMail credits left: 3');
});

// ── status_accepted ──
test('status_accepted: writes Check Status + flips Stage to Connected · DM Now', () => {
  const r = buildSheetDataForAction({
    action: 'status_accepted',
    mode: 'check_status'
  });
  assert.equal(r.checkStatus, 'Connected');
  assert.equal(r.cc, 'Connected');
  assert.equal(r.connectedAlready, 'Yes');
  assert.equal(r.status, 'Check Done.');
  assert.equal(r.stage, 'Connected · DM Now');
});

// ── status_pending ──
test('status_pending: writes Check Status "Still Pending", no stage change', () => {
  const r = buildSheetDataForAction({
    action: 'status_pending',
    mode: 'check_status'
  });
  assert.equal(r.checkStatus, 'Still Pending');
  assert.equal(r.stage, undefined);
});

// ── already_processed (per-mode stage stamps) ──
test('already_processed connect_only → Stage = Connect Pending', () => {
  const r = buildSheetDataForAction({ action: 'already_processed', mode: 'connect_only' });
  assert.equal(r.stage, 'Connect Pending');
});
test('already_processed message_only + introMode → Stage = IC Sent', () => {
  const r = buildSheetDataForAction({ action: 'already_processed', mode: 'message_only', introMode: true });
  assert.equal(r.stage, 'IC Sent');
});
test('already_processed message_only without introMode → Stage = DM Sent', () => {
  const r = buildSheetDataForAction({ action: 'already_processed', mode: 'message_only' });
  assert.equal(r.stage, 'DM Sent');
});
test('already_processed inmail_only → Stage = InM Sent', () => {
  const r = buildSheetDataForAction({ action: 'already_processed', mode: 'inmail_only' });
  assert.equal(r.stage, 'InM Sent');
});

// ── unknown action ──
test('unknown action: returns sender-only payload', () => {
  const r = buildSheetDataForAction({ action: 'mystery', mode: 'connect_only', profileName: 'x@y' });
  assert.equal(r.sender, 'x@y');
  assert.equal(r.status, undefined);
  assert.equal(r.stage, undefined);
});

// ── buildSkipSheetData: routes by mode ──
test('skip in connect_only → Connection Status holds the reason', () => {
  const r = buildSkipSheetData('connect_only', 'Skipped: weekly invitation limit reached', 'a@b');
  assert.equal(r.connectionStatus, 'Skipped: weekly invitation limit reached');
  assert.equal(r.status, 'Skipped: weekly invitation limit reached');
  assert.equal(r.stage, 'Skipped: weekly invitation limit reached');
  assert.equal(r.sender, 'a@b');
});

test('skip in message_only → DM Status holds the reason', () => {
  const r = buildSkipSheetData('message_only', 'Skipped: not connected');
  assert.equal(r.dmStatus, 'Skipped: not connected');
  assert.equal(r.connectionStatus, undefined);
});

test('skip in introduce_back → Intro Status holds the reason', () => {
  const r = buildSkipSheetData('introduce_back', 'Skipped: send not confirmed');
  assert.equal(r.introStatus, 'Skipped: send not confirmed');
});

test('skip in open_profile_only → OP Status', () => {
  const r = buildSkipSheetData('open_profile_only', 'Skipped: Not Open Profile');
  assert.equal(r.opStatus, 'Skipped: Not Open Profile');
});

test('skip in inmail_only → InM Status', () => {
  const r = buildSkipSheetData('inmail_only', 'Skipped: InMail credits exhausted');
  assert.equal(r.inmStatus, 'Skipped: InMail credits exhausted');
});

test('skip in check_status → Check Status', () => {
  const r = buildSkipSheetData('check_status', 'Skipped: URL not found');
  assert.equal(r.checkStatus, 'Skipped: URL not found');
});
