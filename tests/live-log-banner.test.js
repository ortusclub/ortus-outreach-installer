import test from 'node:test';
import assert from 'node:assert/strict';
import { latestBannerEvent, bannerEventOwnsIdleMonitoring } from '../public/js/live-log-banner.mjs';

test('the newest operational log line becomes the banner event', () => {
  const e = latestBannerEvent([
    '10:01:00 INFO Opening sean browser',
    '10:01:04 OK cindy.siapno@ortus.solutions — 0 newly accepted, 42 rows updated · 10:01',
    'Σ Total · 73 sent · 1 error · 124 pending',
  ]);
  assert.equal(e.headline, 'Account check finished');
  assert.equal(e.detail, 'cindy.siapno@ortus.solutions — 0 newly accepted, 42 rows updated');
});

test('banner events expose engine time for monotonic rendering', () => {
  const iso = latestBannerEvent(['[2026-08-26T13:05:12.000Z] Browser opened']);
  const object = latestBannerEvent([{ t: 1787749513000, line: 'Profile opened' }]);
  assert.equal(iso.at, Date.parse('2026-08-26T13:05:12.000Z'));
  assert.equal(object.at, 1787749513000);
});

test('timestamp truth outranks append order in merged campaign logs', () => {
  const e = latestBannerEvent([
    { t: Date.parse('2026-08-26T16:04:00Z'), line: 'ERR Check finished with an error — Action required: manoj.kumar@ortus.solutions: log back into LinkedIn in GoLogin, then Retry' },
    { t: Date.parse('2026-08-26T16:01:00Z'), line: 'Juan C. Rojas, MD, MS · Connected sent · via sean.alcosin@ortus.solutions' },
  ]);
  assert.equal(e.kind, 'check-error');
  assert.equal(e.headline, 'Not every account could be checked');
  assert.match(e.detail, /manoj\.kumar@ortus\.solutions/);
});

test('clock suffixes also prevent an older derived row from replacing a terminal check event', () => {
  const e = latestBannerEvent([
    'ERR Check finished with an error — Action required: manoj needs login · 18:04',
    'Juan C. Rojas · Connected sent · 18:01',
  ], { now: new Date('2026-08-26T18:10:00+02:00') });
  assert.equal(e.kind, 'check-error');
});

test('scheduling the next check does not hide a fresh unresolved sweep error', () => {
  const e = latestBannerEvent([
    'ERR Check finished with an error — Action required: manoj needs login · 18:04',
    'LOG Next check 2026-08-26 16:59 UTC · nothing happens until then, the campaign stays running. · 18:04',
    'Juan C. Rojas · Connected sent · 18:01',
  ], { now: new Date('2026-08-26T18:10:00+02:00') });
  assert.equal(e.kind, 'check-error');
  assert.match(e.detail, /manoj needs login/i);
});

test('summary and divider rows never pin the banner', () => {
  assert.equal(latestBannerEvent([
    'Checking account 2',
    '──────────',
    '━━━━━━━━━━',
    'SUM ———',
    'Σ Total · 3 sent',
  ]).line, 'Checking account 2');
});

test('symbol-only rows can never erase a readable banner', () => {
  assert.equal(latestBannerEvent(['Browser opened', '✓', '■', '────────']).headline, 'Browser opened');
});

test('completed monitoring sweep uses the Next check row above its footer', () => {
  const e = latestBannerEvent([
    '✓ Check complete · 0 newly accepted across 3 accounts · 13:14',
    '◷ Next check 2026-08-26 15:11 UTC · nothing happens until then, the campaign stays running. · 13:14',
    '──────────',
    'Σ Total · 73 sent · 1 error · 124 pending',
  ], { now: new Date('2026-08-26T11:20:00Z') });
  assert.equal(e.headline, 'Waiting for the next acceptance check');
  assert.match(e.detail, /^Today at /);
  assert.doesNotMatch(e.detail, /Campaign stays running/);
  assert.doesNotMatch(e.detail, /2026|UTC/);
  assert.match(e.explanation, /Nothing needs to be done now/);
});

test('local terminal monitoring event restores the normal waiting banner', () => {
  const e = latestBannerEvent([
    'manoj.kumar@ortus.solutions — Identity Restricted in the SoO.',
    '✓ Check complete — some accounts need attention.',
    '🛏 Monitoring active · next check at 15:52.',
  ]);
  assert.equal(e.kind, 'check-waiting');
  assert.equal(e.headline, 'Waiting for the next acceptance check');
  assert.equal(e.detail, 'Today at 15:52');
});

test('tomorrow and later schedules use human dates without a year', () => {
  const now = new Date('2026-08-26T10:00:00Z');
  const tomorrow = latestBannerEvent(['Next check 2026-08-27 15:11 UTC · nothing happens until then'], { now });
  const later = latestBannerEvent(['Next check 2026-08-30 15:11 UTC · nothing happens until then'], { now });
  assert.match(tomorrow.detail, /^Tomorrow at /);
  assert.doesNotMatch(later.detail, /2026|UTC/);
});

test('sender-unavailability uses tomorrow instead of a raw UTC date', () => {
  const e = latestBannerEvent([
    '🌙 No account can send until 2026-08-26 23:59 UTC — sending stops here and acceptance checks carry on. 293 leads left; they go out automatically when it lifts.',
  ], { phase: 'monitoring', now: new Date('2026-08-26T14:00:00+02:00') });
  assert.equal(e.kind, 'sending-paused-monitoring');
  assert.equal(e.headline, 'Sending pauses until tomorrow');
  assert.equal(e.detail, '293 leads remain · acceptance checks continue · resumes automatically tomorrow');
  assert.doesNotMatch(`${e.headline} ${e.detail}`, /2026|UTC|No account can send/i);
});

test('current concise pause event stays concise in the banner', () => {
  const e = latestBannerEvent([
    '🌙 Sending pauses until tomorrow — acceptance checks continue. 293 leads remain and resume automatically tomorrow.',
  ], { phase: 'monitoring' });
  assert.equal(e.headline, 'Sending pauses until tomorrow');
  assert.equal(e.detail, '293 leads remain · acceptance checks continue · resumes automatically tomorrow');
});

test('restored monitoring schedule never exposes raw UTC or cancellation copy', () => {
  const e = latestBannerEvent([
    'Queued check cancelled — monitoring stays active.',
    '⏱ Next check 2026-08-26 12:59 UTC · monitoring stays active.',
  ], { now: new Date('2026-08-26T12:22:00Z') });
  assert.equal(e.kind, 'check-waiting');
  assert.equal(e.headline, 'Waiting for the next acceptance check');
  assert.match(e.detail, /^Today at /);
  assert.doesNotMatch(`${e.headline} ${e.detail}`, /2026|UTC|cancel/i);
});

test('profile-open progress is concise while preserving account and batch position', () => {
  const e = latestBannerEvent([
    'damiano@ortus.solutions · My Tran — Profile opened — preparing the page · Waiting for LinkedIn controls to become ready · 1 of 8 this sending batch',
  ]);
  assert.equal(e.headline, 'Opening My Tran on LinkedIn');
  assert.equal(e.detail, 'damiano@ortus.solutions · Waiting for the profile page · Lead 1 of 8');
  assert.doesNotMatch(e.headline, /waiting|account|batch/i);
});

test('sheet stamping removes duplicate sender and internal wording', () => {
  const e = latestBannerEvent([
    'emanuele.circi@ortus.solutions · emanuele.circi@ortus.solutions · Michael B. — Stamping the result to the sheet · Writing the final status back to Google Sheets · 6 of 8 this sending batch',
  ]);
  assert.equal(e.headline, 'Saving Michael B.’s result');
  assert.equal(e.detail, 'emanuele.circi@ortus.solutions · Writing to the campaign sheet · Lead 6 of 8');
  assert.equal((`${e.headline} ${e.detail}`.match(/emanuele\.circi@ortus\.solutions/g) || []).length, 1);
  assert.doesNotMatch(`${e.headline} ${e.detail}`, /newest verified|Google Sheets|Stamping/i);
});

test('objects and plain local log lines use the same contract', () => {
  const e = latestBannerEvent([{ line: 'WARN manoj.kumar — Identity Restricted' }]);
  assert.equal(e.headline, 'Account skipped safely');
  assert.equal(e.detail, 'manoj.kumar · Identity Restricted');
  assert.match(e.explanation, /Other available accounts continue/);
});

test('local check startup removes ISO metadata and does not claim the browser is open', () => {
  const e = latestBannerEvent([
    '[2026-08-26T12:54:06.914Z] 📡 [sean.alcosin@ortus.solutions] Check now — bulk check pass starting…',
  ], { phase: 'checking' });
  assert.equal(e.kind, 'local-browser-starting');
  assert.equal(e.headline, 'Starting the local browser');
  assert.equal(e.detail, 'sean.alcosin@ortus.solutions · Browser not open yet');
  assert.doesNotMatch(`${e.headline} ${e.detail}`, /2026|12:54|browser is open/i);
});

test('top headlines never contain sender emails or clock metadata', () => {
  const cases = [
    '[2026-08-26T13:16:41.000Z] 📡 [sean.alcosin@ortus.solutions] Launching browser…',
    '[2026-08-26T13:17:01.000Z] 📡 [cindy.siapno@ortus.solutions] Sweeping recent connections…',
    'cindy.siapno@ortus.solutions — 0 newly accepted, 56 rows updated · 15:18',
  ];
  for (const line of cases) {
    const e = latestBannerEvent([line], { phase: 'checking' });
    assert.doesNotMatch(e.headline, /@|\b\d{1,2}:\d{2}\b|2026/);
  }
});

test('VM browser-opening event identifies one authoritative sender', () => {
  const e = latestBannerEvent([
    "🖥️ Opening emanuele.circi@ortus.solutions's browser on the VM — 8/20 sent today",
  ]);
  assert.equal(e.kind, 'sender-browser-opening');
  assert.equal(e.account, 'emanuele.circi@ortus.solutions');
  assert.equal(e.headline, 'Opening the sender browser');
  assert.equal(e.detail, 'emanuele.circi@ortus.solutions · 8 of 20 sent today');
  assert.doesNotMatch(e.headline, /@/);
});

test('resumed sending event outranks a stale idle-monitoring snapshot', () => {
  const sending = latestBannerEvent([
    "🖥️ Opening riccardo@ortus.solutions's browser on the VM — 20/50 sent today · 13:19",
  ], { phase: 'monitoring' });
  const checking = latestBannerEvent([
    'Checking riccardo@ortus.solutions… · 13:19',
  ], { phase: 'monitoring' });
  assert.equal(sending.kind, 'sender-browser-opening');
  assert.equal(bannerEventOwnsIdleMonitoring(sending, true), true);
  assert.equal(bannerEventOwnsIdleMonitoring(checking, true), false);
});

test('real resumed VM sequence advances past an older introduction to the latest sending step', () => {
  const event = latestBannerEvent([
    '✓ Benjamin Lombardo · introduced · 13:18',
    '✓ riccardo@ortus.solutions invited Angie Ruminski-Sontag · 6 of 8 this turn, 26/50 today · 13:27',
    '✓ CJ Jewell, PhD · CC sent · 13:28 · via riccardo@ortus.solutions · linkedin.com/in/ACwAAAR9UmYBHX0b8Glola41GiVL3rTjk2EF2ao',
    '✓ riccardo@ortus.solutions invited CJ Jewell, PhD · 7 of 8 this turn, 27/50 today · 13:28',
    '✓ Khaliq Malik · CC sent · 13:29 · via riccardo@ortus.solutions · linkedin.com/in/ACwAAACc5nQB4M5lsgdc5zyy8adpzJUA7c-2oIE',
    '✓ riccardo@ortus.solutions invited Khaliq Malik · 8 of 8 this turn, 28/50 today · 13:29',
    '⏹ riccardo@ortus.solutions — browser closed · 8 sent this turn (28/50 today) · rests ~3 min before its next turn · 13:29',
    "🖥️ Opening carlos@virtualroundtable.com's browser on the VM — 20/50 sent today · 13:29",
    '📋 carlos@virtualroundtable.com is taking up to 8 people this turn · 13:29',
    '▶ carlos@virtualroundtable.com · Luke Dauparas — Connect pressed from More · Waiting for LinkedIn to open the invitation dialog · 0 of 8 this sending batch · 13:30',
    '▶ carlos@virtualroundtable.com · Luke Dauparas — Send pressed — confirming with LinkedIn · Waiting for LinkedIn or Voyager to confirm the invitation · 0 of 8 this sending batch · 13:30',
    '⚠ carlos@virtualroundtable.com · Luke Dauparas — Send was clicked but Pending was NOT confirmed · LinkedIn may have silently dropped it · 13:31',
    '⏳ carlos@virtualroundtable.com — backing off 66s (degradation streak 1) · 13:31',
    '▶ carlos@virtualroundtable.com · Luke Dauparas — Stamping the result to the sheet · Writing the final status back to Google Sheets · 13:32',
    '──────────',
    'Σ Total · 100 sent · 0 errors · 35 pending',
  ], { phase: 'sending', now: new Date(2026, 7, 27, 13, 32) });
  assert.equal(event.kind, 'saving-result');
  assert.equal(event.headline, 'Saving Luke Dauparas’s result');
  assert.equal(event.detail, 'carlos@virtualroundtable.com · Writing to the campaign sheet');
  assert.doesNotMatch(event.headline, /Benjamin Lombardo/);
});

test('all local check phases expose matching workflow kinds', () => {
  assert.equal(latestBannerEvent(['📡 [sean@ortus.solutions] Launching browser…']).kind, 'account-browser-opening');
  assert.equal(latestBannerEvent(['📡 [cindy@ortus.solutions] Sweeping recent connections…']).kind, 'account-checking');
  assert.equal(latestBannerEvent(["Nobody has accepted cindy@ortus.solutions's 219 outstanding invitations yet. 56 rows refreshed as still waiting."]).kind, 'account-checked');
  assert.equal(latestBannerEvent(['📡 Manual bulk check complete — 0 Connected, 56 Still Pending across 3 accounts.']).kind, 'check-complete');
});

test('check lifecycle events expose progress kinds for the whole panel', () => {
  assert.equal(latestBannerEvent(['Check now — this campaign’s accounts']).kind, 'check-queued');
  assert.equal(latestBannerEvent(['Checking sean@ortus.solutions…']).kind, 'account-checking');
  assert.equal(latestBannerEvent(['sean@ortus.solutions — 0 newly accepted, 22 rows updated']).kind, 'account-checked');
  assert.equal(latestBannerEvent(['Check complete · 0 newly accepted']).kind, 'check-complete');
});
