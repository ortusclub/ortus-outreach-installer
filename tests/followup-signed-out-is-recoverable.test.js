import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBlockedBySession } from '../src/primary-task-runner.js';

const TM = readFileSync(new URL('../src/linkedin/thread-message.js', import.meta.url), 'utf8');
const RUNNER = readFileSync(new URL('../src/primary-task-runner.js', import.meta.url), 'utf8');
const LAUNCH = readFileSync(new URL('../src/local-launcher.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const GOLOGIN = readFileSync(new URL('../src/gologin-launcher.js', import.meta.url), 'utf8');

// 1 Sep: five follow-ups died three attempts at a time reading
// FOLLOWUP_COMPOSER_NOT_FOUND. The browser was signed in at 17:12 (its session
// was captured and uploaded) and serving guest cookies by 17:46. An authwall has
// no composer, so the two causes shared one error and one useless message.
test('a signed-out page is named as such, not as a missing composer', () => {
  assert.match(TM, /export async function isSignedOut/);
  const uses = TM.match(/if \(await isSignedOut\(page\)\) throw new Error\('FOLLOWUP_SIGNED_OUT'\)/g) || [];
  assert.equal(uses.length, 2, 'both the composer and the thread path must ask');
});

test('the probe checks the URL and the page, and never throws', () => {
  const i = TM.indexOf('export async function isSignedOut');
  const body = TM.slice(i, i + 1200);
  assert.match(body, /login|authwall|checkpoint/);
  assert.match(body, /global-nav/, 'a signed-in page is identified positively');
  assert.match(body, /catch \(_\) \{ return false; \}/, 'a probe failure must not become a false alarm');
});

test('signed-out parks the task instead of spending an attempt', () => {
  assert.equal(isBlockedBySession(new Error('FOLLOWUP_SIGNED_OUT')), true);
  assert.equal(isBlockedBySession(new Error('FOLLOWUP_COMPOSER_NOT_FOUND')), false);
  assert.equal(isBlockedBySession(null), false);
  const i = RUNNER.indexOf('async function _settleFailure');
  const body = RUNNER.slice(i, i + 1400);
  assert.match(body, /attempts: task\.attempts \|\| 0/, 'parking must not increment attempts');
  assert.match(body, /'pending'/);
});

test('a parked task backs off so it cannot relaunch Chrome every tick', () => {
  assert.match(RUNNER, /const SESSION_BACKOFF_MS = 30 \* 60 \* 1000/);
  const i = RUNNER.indexOf('async function _settleFailure');
  assert.match(RUNNER.slice(i, i + 1400), /dueAt: Date\.now\(\) \+ SESSION_BACKOFF_MS/);
});

test('the session is probed once per run, not once per lead', () => {
  const i = RUNNER.indexOf('session = await preparePrimarySession(local');
  const body = RUNNER.slice(i, i + 900);
  assert.match(body, /prepare: checkSignedOut/);
  assert.match(body, /if \(session.prepared\)/);
  assert.ok(body.indexOf('checkSignedOut') < body.indexOf('for (const t of local)'),
    'the probe must come before the per-lead loop');
});

test('the login flow opens the browser where a human can see it', () => {
  assert.match(LAUNCH, /launchLocalBrowser\(\{ visible = false, signal \} = \{\}\)/);
  assert.match(LAUNCH, /visible \? \['--window-position=60,60'\] : \['--window-position=-2400,-2400'\]/);
  assert.match(LAUNCH, /defaultViewport: visible \? null/,
    'manual login must use the real Chrome viewport, not automation emulation');
  assert.match(LAUNCH, /if \(!visible\) await page\.setViewport/,
    'only hidden automated work should install a synthetic viewport');
  assert.match(LAUNCH, /if \(pid && !visible\)/,
    'the operator-visible login browser must never be hidden');
  assert.match(LAUNCH, /activeBrowser && activeBrowser\.connected/,
    'repeated recovery/retry must reuse one profile owner');
  assert.match(LAUNCH, /await page\.setViewport\(null\)/,
    'reopening an existing automated window for a human must clear emulation');
  assert.match(SERVER, /launchLocalBrowser\(\{ visible: true \}\)/);
});

test('GoLogin recovery opens as a manual browser, not a visible automation window', () => {
  assert.match(GOLOGIN, /launchProfile\(profileId, _ignoredLegacyToken, \{ visible = false, signal \} = \{\}\)/);
  assert.match(GOLOGIN, /defaultViewport: visible \? null/);
  assert.match(GOLOGIN, /if \(!visible\) await page\.setViewport/);
  assert.match(GOLOGIN, /if \(!visible\) await applyFocusEmulation/);
  assert.match(GOLOGIN, /showProfileForManualControl/);
  assert.match(GOLOGIN, /Emulation\.setFocusEmulationEnabled', \{ enabled: false \}/);
  assert.match(GOLOGIN, /activeProfiles\.has\(profileId\) && activeSessions\.has\(profileId\)/,
    'retry must reuse the profile that the operator just signed into');
  assert.match(GOLOGIN, /prepareProfileForAutomation\(profileId\)/,
    'retry must deliberately return that browser to automated operation');
  assert.match(SERVER, /launchProfile\(profileId, token, \{ visible: true \}\)/);
  assert.match(SERVER, /showProfileForManualControl\(profileId\)/);
});

test('retry revives BOTH parked and already-failed follow-ups', () => {
  const i = SERVER.indexOf("app.post('/api/followups/retry'");
  const body = SERVER.slice(i, i + 900);
  assert.match(body, /t\.status === 'failed'/, "1 Sep's five are already 'failed'");
  assert.match(body, /t\.status === 'pending' && t\.blockedBySession/);
  assert.match(body, /attempts: 0/);
  assert.match(body, /dueAt: Date\.now\(\)/, 'retry must clear the 30-minute backoff');
});

test('the card can finally say a follow-up did not land', () => {
  assert.match(SERVER, /app\.get\('\/api\/followups\/health'/);
  assert.match(APP, /_followupFixHtml/);
  assert.match(APP, /openFollowupLogin/);
  assert.match(APP, /retryFollowups/);
  assert.match(APP, /facts\.push\(\['Follow-ups'/);
});

test('the follow-up block is not limited to the waiting phase', () => {
  // Takes the campaign id since v3.1.60.6: the block must speak for the campaign
  // whose card it is on, not for whichever campaign refreshed last.
  const i = APP.indexOf("const _fuFix = _followupFixHtml(cid);");
  assert.ok(i > 0, 'the fix block must be built for a named campaign');
  assert.match(APP.slice(i, i + 200), /\|\| _fuFix/);
});
