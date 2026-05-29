import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates } from '../src/linkedin/bulk-check-connections.js';

const baseRow = (overrides = {}) => ({
  'First Name': 'Jane',
  'Last Name': 'Doe',
  'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
  'Connection Request Status': 'Connection Request Sent',
  'Connected Status': '',
  ...overrides,
});

const baseConns = [
  { firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'eryca.bilazon@ortus.solutions' },
];

const stillPendingLabel = 'Still Pending (2026-05-12 10:00)';
const linkedinColumn = 'LinkedIn URL';

test('suppressAcceptedStamp=false: matched URL gets cc + connectedAlready in updates', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 1);
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match, 'matched URL should be in updates');
  assert.equal(match.cc, 'Connected');
  assert.equal(match.connectedAlready, 'Yes');
});

test('suppressAcceptedStamp=true: matched URL returned in connectedUrls but NOT in updates', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: true }
  );
  assert.equal(connectedUrls.length, 1, 'connectedUrls preserved');
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(match, undefined, 'matched URL stamp suppressed from updates');
});

test('suppressAcceptedStamp=true: still-pending rows STILL get stamped', () => {
  const pendingRow = baseRow({
    'First Name': 'Bob',
    'Last Name': 'Smith',
    'LinkedIn URL': 'https://linkedin.com/in/bob-smith',
  });
  const { updates } = computeBulkCheckUpdates(
    [pendingRow], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: true }
  );
  const pendingStamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/bob-smith');
  assert.ok(pendingStamp, 'still-pending row should be stamped regardless of flag');
  assert.equal(pendingStamp.cc, stillPendingLabel);
});

test('back-compat: row with CC=Connected (new header) AND introduction made is skipped', () => {
  // v2.14.x: CC=Connected alone is NOT enough to skip — the intro might
  // have been interrupted (Stop pressed, browser died) leaving a Skipped
  // stamp that needs re-pickup. The authoritative "intro done" signal is
  // introductionStatus='Introduction Made'. See bulk-check-connections.js
  // re-ordering for SB-2.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'Introduction Status': 'Introduction Made',
  })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'rows with intro already made are skipped');
});

test('SB-2 fix: row with CC=Connected but BLANK introductionStatus is re-pushed for intro retry', () => {
  // Repro of the SB-2 bug: a lead whose intro was interrupted mid-batch
  // had CC=Connected but no introductionStatus. Previous filter skipped
  // them forever; new filter re-pushes them to connectedUrls so the next
  // auto-intro pass fires.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    // No Introduction Status — intro never fired or got interrupted.
  })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'CC=Connected without intro IS re-pushed for retry');
  // CC is already at its target value — don't redundantly re-stamp it.
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(stamp, undefined, 'no CC re-stamp when already Connected');
});

test('SB-2 fix: row with CC=Connected + Skipped — Stop pressed is re-pushed for intro retry', () => {
  // Specifically tests the new 'Skipped — Stop pressed' / 'Skipped — browser
  // closed' status from auto-intro.js's graceful-abort path. These statuses
  // must be treated identically to 'no intro status' — re-push for retry,
  // do not re-stamp CC.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Introduction Status': 'Skipped — Stop pressed',
  })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'Skipped status is treated as not-yet-introduced');
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(stamp, undefined, 'no CC re-stamp');
});

test('empty conns: pending rows still get Still Pending stamp; matched-set lookups yield no false matches', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, [], linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'no connections → no matches');
  // Row's request status IS "Connection Request Sent" → gets stamped Still Pending.
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(stamp, 'row should be stamped Still Pending');
  assert.equal(stamp.cc, stillPendingLabel);
});

test('empty rows: returns empty updates, empty connectedUrls, zero counters', () => {
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(updates.length, 0);
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.rowsScanned, 0);
  assert.equal(diag.withUrl, 0);
});

test('row with missing LinkedIn URL: silently skipped, doesn\'t throw', () => {
  const rowWithoutUrl = { 'First Name': 'No', 'Last Name': 'URL' };
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [rowWithoutUrl], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(updates.length, 0, 'no URL → no stamp');
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.rowsScanned, 1, 'still counted as scanned');
  assert.equal(diag.withUrl, 0, 'but withUrl=0 since URL was missing');
});

// v2.14.x — pre-existing 1st-degree connection branching
test('matched + wasInvited: stamps Connected + Stage=Connected (v2.62 sync fix)', () => {
  // v2.62: Stage now flips to 'Connected' alongside cc so the row reads
  // consistently. Previously Stage stayed at 'Connect Pending' while cc
  // showed 'Connected' — operator confusion fix.
  const rows = [baseRow({ 'Connection Request Status': 'Connection Request Sent' })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { updates } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match);
  assert.equal(match.cc, 'Connected');
  assert.equal(match.checkStatus, 'Connected');
  assert.equal(match.stage, 'Connected', 'v2.62: wasInvited path stamps stage to keep columns in sync');
  assert.equal(match.sender, undefined, 'wasInvited path does NOT stamp sender (assigned sender stays)');
});

test('matched + NOT invited: stamps Sender + Stage = "Already connected" (pre-existing 1st-degree)', () => {
  // Row has no prior outreach by the bot — it's a lead the operator
  // already had as a 1st-degree connection. Bulk-check should stamp the
  // account that's connected so the operator sees WHO, and pre-filter
  // can skip the row from new connect sends.
  const rows = [baseRow({ 'Connection Request Status': '' })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'still pushed to connectedUrls so runAutoIntros fires');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match);
  assert.equal(match.sender, 'kenya5@ortus.solutions');
  assert.equal(match.stage, 'Already connected');
  assert.equal(match.cc, 'Already connected');
  assert.equal(match.checkStatus, 'Already connected');
  assert.equal(match.connectedAlready, 'Yes');
});

test('matched + NOT invited + suppressAcceptedStamp: no stamp but URL returned for IC DM', () => {
  const rows = [baseRow({ 'Connection Request Status': '' })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: true, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'connectedUrls still populated');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(match, undefined, 'no stamp when suppressAcceptedStamp is true');
});

test('row marked "Already connected" + introduction already made: skipped (no re-stamp)', () => {
  // v2.14.x: CC='Already connected' alone is NOT enough — the row could
  // need an intro retry if the introductionStatus is blank/Skipped/Failed.
  // Authoritative "skip me" signal is introductionStatus='Introduction Made'
  // (or 'Introduction Already Made').
  const rows = [baseRow({
    'Connection Accepted Status': 'Already connected',
    'Connected Status': '',
    'Introduction Status': 'Introduction Made',
  })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 0, 'intro-already-made rows not re-pushed');
  assert.equal(updates.length, 0, 'no re-stamp');
});

test('sticky downgrade: row with CC starting with "Unverified — manual review" is skipped before isMatch', () => {
  const downgradedRow = baseRow({
    'First Name': 'Jane',
    'Last Name': 'Doe',
    'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
    'Connection Request Status': 'Connection Request Sent',
    'Connection Accepted Status': 'Unverified — manual review (May 27th, 2026)',
  });
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [downgradedRow], baseConns, linkedinColumn, stillPendingLabel, {}
  );
  assert.ok(
    !connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'downgraded row must NOT be queued for auto-intro'
  );
  assert.ok(
    !updates.some((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe'),
    'downgraded row must NOT receive any stamp write this pass'
  );
  assert.equal(diag.alreadyUnverified, 1, 'diag counter should record the skip');
});

test('cap: URL with composeAttempts >= 3 is excluded from connectedUrls', () => {
  const matchingRow = baseRow();
  const composeAttempts = new Map([['https://linkedin.com/in/jane-doe', 3]]);
  const { connectedUrls, diag } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, { composeAttempts }
  );
  assert.ok(
    !connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'URL with 3+ compose-textbox failures must not re-enter the intro queue'
  );
  assert.equal(diag.composeCapped, 1, 'diag counter should record the cap skip');
});

test('cap: URL with composeAttempts < 3 still flows through to connectedUrls', () => {
  const matchingRow = baseRow();
  const composeAttempts = new Map([['https://linkedin.com/in/jane-doe', 2]]);
  const { connectedUrls } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, { composeAttempts }
  );
  assert.ok(
    connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'URL below the cap must still be queued for auto-intro retry'
  );
});

test('cap: no composeAttempts opt (undefined) defaults to allow', () => {
  const matchingRow = baseRow();
  const { connectedUrls } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, {}
  );
  assert.ok(
    connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'omitted composeAttempts must not block any URL (back-compat)'
  );
});

// ──────────────────────────────────────────────────────────────────────
// v2.62 — sender-scoped matching (cross-account false-positive prevention)
// ──────────────────────────────────────────────────────────────────────

const rowWithSender = (sender, overrides = {}) => baseRow({
  Sender: sender,
  ...overrides,
});

test('v2.62: cross-sender match → Stage="Already connected to X", no CC stamp, no connectedUrls push', () => {
  // Row's Sender is carmella but eryca's bulk-check finds the lead in her
  // network. Eryca should NOT stamp cc=Connected (would be a false positive
  // for carmella's still-pending invite) and should NOT push to connectedUrls
  // (would fire eryca's auto-DM/intro on a row that isn't hers).
  const rows = [rowWithSender('carmella.s@ortus.solutions')];
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  // activeSenders = { carmella, eryca? } — no, only carmella. So eryca isn't
  // in activeSenders. Hmm need a second sheet row with Sender=eryca to put
  // her in activeSenders. Re-run with both senders present.
  assert.equal(updates.length, 0, 'eryca not in activeSenders → no stamps');
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.skippedNotActiveSender, 1, 'caller-not-active-sender defense fired');
});

test('v2.62: cross-sender match (both senders active) → "Already connected to X" Stage, no CC stamp', () => {
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other',
      'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  // Jane is in eryca's connections (baseConns). Eryca's bulk-check runs.
  // Jane's row has Sender=carmella. → cross-sender match.
  const janeUpdate = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(janeUpdate, 'jane gets an informational stage stamp');
  assert.equal(janeUpdate.stage, 'Already connected to eryca.bilazon@ortus.solutions');
  assert.equal(janeUpdate.cc, undefined, 'cc NOT stamped — would be false positive for carmella');
  assert.equal(janeUpdate.checkStatus, undefined, 'checkStatus NOT stamped either');
  assert.ok(!connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'jane NOT in connectedUrls — eryca shouldn\'t fire auto-DM on carmella\'s row');
  assert.equal(diag.crossSender, 1);
});

test('v2.62: same-sender match still works (normal acceptance, with Stage=Connected fix)', () => {
  const rows = [rowWithSender('eryca.bilazon@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match);
  assert.equal(match.cc, 'Connected');
  assert.equal(match.stage, 'Connected', 'Bug 2 fix: Stage flips to Connected alongside cc');
  assert.equal(connectedUrls.length, 1, 'auto-DM/intro can fire (same-sender)');
});

test('v2.62: cross-sender no-match does NOT downgrade to Still Pending', () => {
  // Two-sender campaign. Jane's row Sender=carmella. Eryca's bulk-check runs
  // but doesn't have Jane in her connections (empty conns). Eryca should NOT
  // stamp Still Pending on carmella's row.
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const emptyConns = []; // eryca has no matching connections
  const { updates } = computeBulkCheckUpdates(
    rows, emptyConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const janeStamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(janeStamp, undefined,
    'eryca must not stamp Still Pending on carmella\'s row');
});

test('v2.62: cross-sender match where assigned sender already stamped Connected → leave alone', () => {
  // Carmella already stamped cc=Connected on Jane. Eryca then finds Jane.
  // Eryca should NOT overwrite Stage with "Already connected to eryca" because
  // the assigned sender's acceptance has already been confirmed.
  const rows = [rowWithSender('carmella.s@ortus.solutions', {
    'Connection Accepted Status': 'Connected',
  }), rowWithSender('eryca.bilazon@ortus.solutions', {
    'First Name': 'Other', 'Last Name': 'Person',
    'LinkedIn URL': 'https://linkedin.com/in/other-person',
  })];
  const { updates } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const janeStamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(janeStamp, undefined,
    'eryca leaves the already-Connected row alone (idempotency)');
});

test('v2.62: legacy sheet with no Sender column behaves like pre-fix code', () => {
  // baseRow doesn't include a Sender column. activeSenders is empty →
  // senderScopingActive=false → no scoping applied → existing behavior.
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match, 'legacy no-Sender sheet still gets stamped');
  assert.equal(match.cc, 'Connected');
  assert.equal(connectedUrls.length, 1);
});

test('v2.62: caller not in activeSenders → defensive empty return', () => {
  // Sara is selected in the UI but no sheet row has Sara as Sender.
  // Defense: sara's bulk-check returns empty updates.
  const rows = [
    rowWithSender('eryca.bilazon@ortus.solutions'),
    rowWithSender('carmella.s@ortus.solutions', {
      'First Name': 'Carm', 'Last Name': 'Row',
      'LinkedIn URL': 'https://linkedin.com/in/carm-row',
    }),
  ];
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'sara@ortus.solutions' }
  );
  assert.equal(updates.length, 0, 'sara isn\'t a campaign sender → no stamps');
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.skippedNotActiveSender, 2, 'defense counted all rows');
});

// ──────────────────────────────────────────────────────────────────────
// Tab-as-Bible — per-entry account attribution (accumulated tab matching)
// ──────────────────────────────────────────────────────────────────────

// A connection carrying an explicit owning account (as stored in the tab).
const connWithAccount = (account, overrides = {}) => ({
  firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe',
  urn: 'ACoAAaaa', memberNumber: '111', account, ...overrides,
});

test('accumulation: lead owned by the row\'s assigned sender → Connected (even when another account is sweeping)', () => {
  // Carmella swept earlier and recorded Jane under her account. Eryca sweeps
  // now; the accumulated tab still carries Jane@carmella. Jane's row is
  // assigned to carmella → must read Connected, NOT cross-sender.
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const accumulated = [connWithAccount('carmella.s@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(jane, 'jane gets stamped');
  assert.equal(jane.cc, 'Connected', 'assigned-sender ownership → Connected');
  assert.ok(connectedUrls.includes('https://linkedin.com/in/jane-doe'));
});

test('attribution: lead owned ONLY by a different campaign sender → "Already connected to <that account>"', () => {
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  // Jane is owned by eryca in the tab, but her row is assigned to carmella.
  const accumulated = [connWithAccount('eryca.bilazon@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(jane);
  assert.equal(jane.stage, 'Already connected to eryca.bilazon@ortus.solutions');
  assert.equal(jane.cc, undefined, 'no Connected stamp on another sender\'s row');
  assert.ok(!connectedUrls.includes('https://linkedin.com/in/jane-doe'));
});

test('attribution: lead owned by BOTH assigned sender and another → Connected wins', () => {
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const accumulated = [
    connWithAccount('carmella.s@ortus.solutions'),
    connWithAccount('eryca.bilazon@ortus.solutions'),
  ];
  const { updates } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(jane.cc, 'Connected', 'assigned sender owns it → Connected regardless of others');
});

test('attribution: name-only match (no slug/urn overlap) still attributes to the owning account', () => {
  // The tab entry shares neither publicId nor urn with the row's URL — only
  // the first+last name matches. Attribution must still flow through the
  // nameToAccounts index so the assigned-sender decision is correct.
  const rows = [rowWithSender('carmella.s@ortus.solutions', {
    'First Name': 'Jane', 'Last Name': 'Doe',
    'LinkedIn URL': 'https://linkedin.com/in/jane-d-99',
  })];
  const accumulated = [{
    firstName: 'Jane', lastName: 'Doe', publicId: 'someone-else-slug',
    urn: 'ACoAAzzz', memberNumber: '999', account: 'carmella.s@ortus.solutions',
  }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'carmella.s@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-d-99');
  assert.ok(jane, 'name-only match still produces a stamp');
  assert.equal(jane.cc, 'Connected', 'name match attributed to assigned sender → Connected');
  assert.ok(connectedUrls.includes('https://linkedin.com/in/jane-d-99'));
});

test('live-fallback contract: conn attributed to sweeping profile → assigned-sender row reads Connected', () => {
  // Mirrors bulkCheckConnections' degrade path: when the accumulated tab set
  // is unavailable, the live fetch is attributed to the sweeping profile
  // (account = pName). A row assigned to that same sender must read Connected.
  const rows = [rowWithSender('carmella.s@ortus.solutions')];
  const attributed = [connWithAccount('carmella.s@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, attributed, linkedinColumn, stillPendingLabel,
    { profileName: 'carmella.s@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(jane.cc, 'Connected', 'live-fetch attributed to sweeper → Connected');
  assert.ok(connectedUrls.includes('https://linkedin.com/in/jane-doe'));
});

test('live-fallback contract: account-less conn does NOT mark a sender-scoped row Connected (why attribution is required)', () => {
  // If the fallback forgot to attribute (account = ''), the assigned-sender
  // row would NOT read Connected — documenting why bulkCheckConnections must
  // set account = pName on the degrade path.
  const rows = [rowWithSender('carmella.s@ortus.solutions')];
  const accountLess = [connWithAccount('')]; // account: ''
  const { updates } = computeBulkCheckUpdates(
    rows, accountLess, linkedinColumn, stillPendingLabel,
    { profileName: 'carmella.s@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.notEqual(jane && jane.cc, 'Connected', 'account-less conn must not produce a Connected stamp on a scoped row');
});
