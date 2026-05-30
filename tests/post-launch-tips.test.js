import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  substituteTokens,
  getTipsForMode,
  renderModalTipsHtml,
  renderSidebarTipsHtml,
  getKnownModes,
} from '../public/js/post-launch-tips.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Token substitution — pure
// ─────────────────────────────────────────────────────────────────────────

test('substituteTokens replaces every known token', () => {
  const out = substituteTokens(
    '{dailyLimit}/{delayMin}-{delayMax}/{checkIntervalMinutes}/{primaryName}',
    { dailyLimit: 50, delayMin: 15, delayMax: 45, checkIntervalMinutes: 60, primaryName: 'Antonio' }
  );
  assert.equal(out, '50/15-45/60/Antonio');
});

test('substituteTokens uses "—" for missing values', () => {
  const out = substituteTokens('{dailyLimit} {primaryName}', { dailyLimit: 50 });
  assert.equal(out, '50 —');
});

test('substituteTokens uses "—" for empty string', () => {
  const out = substituteTokens('{primaryName}', { primaryName: '' });
  assert.equal(out, '—');
});

test('substituteTokens leaves unknown braces alone (whitelist)', () => {
  const out = substituteTokens('Hello {firstName}!', { firstName: 'Ignored' });
  assert.equal(out, 'Hello {firstName}!');
});

test('substituteTokens returns empty string for non-string input', () => {
  assert.equal(substituteTokens(null), '');
  assert.equal(substituteTokens(undefined), '');
  assert.equal(substituteTokens(42), '');
});

// ─────────────────────────────────────────────────────────────────────────
// Tip retrieval — every mode resolves
// ─────────────────────────────────────────────────────────────────────────

test('getKnownModes returns all 9 modes', () => {
  const modes = getKnownModes();
  assert.equal(modes.length, 9);
  assert.deepEqual(modes.sort(), [
    'check_dms',
    'check_status',
    'connect_and_introduce',
    'connect_only',
    'inmail_only',
    'introduce_back',
    'message_only',
    'open_profile_only',
    'post_amplification',
  ]);
});

test('getTipsForMode resolves connect_only with dynamic tokens', () => {
  const set = getTipsForMode('connect_only', { dailyLimit: 50, delayMin: 15, delayMax: 45 });
  assert.equal(set.modalTitle, "YOU'RE LIVE. A FEW THINGS TO KNOW.");
  assert.equal(set.tips.length, 5);
  const dailyLimitTip = set.tips.find(t => t.icon === '📤');
  assert.ok(dailyLimitTip.full.includes('Daily limit: 50/profile'));
  assert.ok(dailyLimitTip.full.includes('15–45 s'));
});

test('getTipsForMode resolves connect_and_introduce with cadence token', () => {
  const set = getTipsForMode('connect_and_introduce', { checkIntervalMinutes: 30 });
  const monitorTip = set.tips.find(t => t.icon === '🔁');
  assert.ok(monitorTip.full.includes('every 30 min'));
  assert.ok(monitorTip.short.includes('every 30 min'));
});

test('getTipsForMode resolves introduce_back with primary name', () => {
  const set = getTipsForMode('introduce_back', { primaryName: 'Antonio Varlese' });
  const primaryTip = set.tips.find(t => t.icon === '🧷');
  assert.ok(primaryTip.full.includes('Antonio Varlese'));
});

test('getTipsForMode falls back to "—" for missing primary name on IB', () => {
  const set = getTipsForMode('introduce_back', {});
  const primaryTip = set.tips.find(t => t.icon === '🧷');
  assert.ok(primaryTip.full.includes('—'));
});

test('getTipsForMode returns null for unknown mode', () => {
  assert.equal(getTipsForMode('nonexistent_mode'), null);
  assert.equal(getTipsForMode(''), null);
  assert.equal(getTipsForMode(undefined), null);
});

test('every mode has at least 4 tips and exactly 1 stop tip', () => {
  for (const mode of getKnownModes()) {
    const set = getTipsForMode(mode, {});
    assert.ok(set.tips.length >= 4, `${mode} must have ≥4 tips, got ${set.tips.length}`);
    const stopTips = set.tips.filter(t => t.icon === '⛔');
    assert.equal(stopTips.length, 1, `${mode} should have exactly one ⛔ stop tip`);
  }
});

test('every mode has a lid-open (💻) tip — the universal one', () => {
  for (const mode of getKnownModes()) {
    const set = getTipsForMode(mode, {});
    const lid = set.tips.find(t => t.icon === '💻');
    assert.ok(lid, `${mode} missing 💻 lid-open tip`);
    assert.ok(/lid open/i.test(lid.full), `${mode}'s 💻 tip should mention "lid open"`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// HTML render helpers
// ─────────────────────────────────────────────────────────────────────────

test('renderModalTipsHtml emits <ul class="ptm-list"> with one <li> per tip', () => {
  const opts = { dailyLimit: 50, delayMin: 15, delayMax: 45 };
  const html = renderModalTipsHtml('connect_only', opts);
  assert.ok(html.startsWith('<ul class="ptm-list">'));
  const liCount = (html.match(/<li>/g) || []).length;
  // Derive from the tip set so this stays correct as tips are added/removed.
  assert.equal(liCount, getTipsForMode('connect_only', opts).tips.length);
});

test('renderSidebarTipsHtml emits <ul class="pts-list"> with one-liner per tip', () => {
  const html = renderSidebarTipsHtml('connect_and_introduce', { checkIntervalMinutes: 60 });
  assert.ok(html.startsWith('<ul class="pts-list">'));
  // Sidebar uses short copy, not full — sidebar short for the 🔁 tip is
  // "Monitors 7 days · every {checkIntervalMinutes} min."
  assert.ok(html.includes('Monitors 7 days'));
  assert.ok(html.includes('every 60 min'));
});

test('renderModalTipsHtml returns empty string for unknown mode', () => {
  assert.equal(renderModalTipsHtml('nope'), '');
  assert.equal(renderSidebarTipsHtml('nope'), '');
});

// ─────────────────────────────────────────────────────────────────────────
// Regression guards — claims we verified against codebase, must stay accurate
// ─────────────────────────────────────────────────────────────────────────

test('regression: CC tip set does not promote a monitoring phase', () => {
  // connect_only has no acceptance-watching phase to advertise, so it must not
  // carry the dedicated monitoring tips that the intro flows use (the 7-day
  // re-check 🔁 and the pre-check heads-up ⏰), nor describe monitoring as an
  // active running feature. The shared "sheet snapshot" tip may still list
  // "monitoring" incidentally as one of the frozen states — that's allowed.
  const set = getTipsForMode('connect_only', {});
  const dedicatedMonitoringIcons = ['🔁', '⏰'];
  for (const tip of set.tips) {
    assert.equal(dedicatedMonitoringIcons.includes(tip.icon), false,
      `CC tip set should not include a dedicated monitoring tip: "${tip.full}"`);
    assert.equal(/monitoring (runs|active|re-?checks?)|re-?check every/i.test(tip.full), false,
      `CC tip should not promote monitoring as a phase: "${tip.full}"`);
  }
});

test('regression: DM/IB/InM/OP tips do NOT mention daily limit (they bypass it)', () => {
  for (const mode of ['message_only', 'introduce_back', 'inmail_only', 'open_profile_only']) {
    const set = getTipsForMode(mode, {});
    const hasDailyLimit = set.tips.some(t => /daily limit/i.test(t.full) && !/no daily limit/i.test(t.full));
    assert.equal(hasDailyLimit, false, `${mode} should not promise a daily limit (it has none)`);
  }
});

test('regression: post_amplification tip set mentions 60–300 s gap, not 30–60 min', () => {
  const set = getTipsForMode('post_amplification', {});
  const allText = set.tips.map(t => t.full).join(' ');
  assert.ok(/60.?300/i.test(allText), 'Post Amp should mention the verified 60–300 s gap');
  assert.equal(/30.?60.?min/i.test(allText), false, 'Post Amp should NOT claim 30–60 min spread');
});
