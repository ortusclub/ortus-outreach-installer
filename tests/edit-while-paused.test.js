import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  campaign,
  normalizeTemplates,
  setLiveTemplates,
  setLiveDailyLimit,
  setLiveCadence,
} from '../src/campaign.js';

// Reset the campaign flags to a clean, non-running state between assertions so
// each test starts from a known baseline (the campaign object is a singleton).
function resetCampaign() {
  campaign.running = false;
  campaign._paused = false;
  campaign._pauseRequested = false;
}

// ── Task A1: normalizeTemplates extraction + live template setter ──

test('normalizeTemplates maps note/ccDmBody/intro fields', () => {
  const t = normalizeTemplates(
    { note: 'hi {first name}', ccDmBody: 'dm', primaryIntroBody: 'intro' },
    'connect_and_introduce',
  );
  assert.equal(t.connectionNote, 'hi {first name}');
  assert.equal(t.ccDmBody, 'dm');
  assert.equal(t.primaryIntroBody, 'intro');
});

test('setLiveTemplates mutates the SAME tpl object in place (live for the loop)', () => {
  const tplRef = normalizeTemplates({ note: 'old' }, 'connect_only');
  campaign.running = true;
  campaign._paused = true;
  campaign._liveTpl = tplRef;
  campaign._liveMode = 'connect_only';
  const r = setLiveTemplates({ note: 'new', ccDmBody: 'x' });
  assert.equal(r.ok, true);
  assert.equal(tplRef.connectionNote, 'new', 'same object reference now has new value');
  assert.equal(campaign.templates.ccDmBody, 'x');
  resetCampaign();
});

test('setLiveTemplates mutates campaign.templates IN PLACE (live message BODY for auto-intro/DM)', () => {
  // The auto-intro / auto-DM call sites pass the raw `templates` object by
  // reference and read primaryIntroBody / ccDmBody off it for the actual sent
  // body. Monitoring reads campaign.templates. Both must see the edit, so the
  // setter must mutate the SAME object — not reassign campaign.templates.
  const rawRef = { primaryIntroBody: 'old intro', ccDmBody: 'old dm' };
  campaign.running = true;
  campaign._paused = true;
  campaign.templates = rawRef;
  campaign._liveTpl = normalizeTemplates(rawRef, 'connect_and_introduce');
  campaign._liveMode = 'connect_and_introduce';
  setLiveTemplates({ primaryIntroBody: 'NEW intro', ccDmBody: 'NEW dm' });
  assert.equal(campaign.templates, rawRef, 'campaign.templates must remain the SAME object reference');
  assert.equal(rawRef.primaryIntroBody, 'NEW intro', 'the body the auto-intro call site holds is now live');
  assert.equal(rawRef.ccDmBody, 'NEW dm');
  resetCampaign();
});

test('setLiveTemplates rejects when not paused', () => {
  campaign.running = true;
  campaign._paused = false;
  campaign._pauseRequested = false;
  assert.equal(setLiveTemplates({ note: 'x' }).ok, false);
  resetCampaign();
});

// ── Task A2: live daily-limit + cadence setters ──

test('setLiveDailyLimit clamps and sets campaign.dailyLimit (paused only)', () => {
  campaign.running = true;
  campaign._paused = true;
  campaign.dailyLimit = 50;
  assert.equal(setLiveDailyLimit(80).ok, true);
  assert.equal(campaign.dailyLimit, 80);
  campaign._paused = false;
  assert.equal(setLiveDailyLimit(10).ok, false); // not paused
  assert.equal(campaign.dailyLimit, 80); // unchanged
  resetCampaign();
});

test('setLiveCadence clamps via clampCadenceMinutes and sets campaign.checkIntervalMinutes', () => {
  campaign.running = true;
  campaign._paused = true;
  assert.equal(setLiveCadence(240).ok, true);
  assert.equal(campaign.checkIntervalMinutes, 240);
  assert.equal(setLiveCadence(5).ok, true); // 5 -> clamped to MIN (60)
  assert.equal(campaign.checkIntervalMinutes, 60);
  resetCampaign();
});
