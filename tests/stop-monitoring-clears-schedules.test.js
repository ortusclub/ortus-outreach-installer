// Regression: stopping a monitoring campaign must remove its persisted
// post-campaign reply + bulk SCHEDULE entries. The dashboard's past-card
// "● Monitoring · N days" chip is computed server-side (_monitoringForEntry
// in server.js) from those on-disk schedule files — NOT from in-memory
// state. Before the fix, stopMonitoring() cleared the monitoring slice but
// left the schedule files intact, so a stopped campaign kept showing
// "monitoring · 7 days" for ~7 days.
//
// The schedule file paths (post-campaign-reply-check.json /
// post-campaign-bulk-check.json) resolve from ORTUS_DATA_DIR at import time
// (paths.js reads the env var ONCE at module load, and each schedule module
// captures SCHEDULE_FILE = dataPath(...) at module level). So the env var
// MUST be set BEFORE anything that pulls in paths.js — including campaign.js
// transitively. Static ES imports are hoisted, so we set the var here and
// load every module via top-level `await import()`. Mirrors the established
// pattern in tests/history-relaunch.test.js.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ortus-stop-mon-clears-'));
process.env.ORTUS_DATA_DIR = TEST_DATA_DIR;

// Dynamic imports — run AFTER the env var is set, so paths.js resolves ROOT
// to TEST_DATA_DIR and both schedule modules write into it.
const replyMod = await import('../src/post-campaign-reply-check.js');
const bulkMod = await import('../src/post-campaign-bulk-check.js');
const { campaign, stopMonitoring } = await import('../src/campaign.js');

const SHEET_ID = 'SHEET123';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/SHEET123/edit';
const PROFILE_ID = 'p1';
const FAR_FUTURE_DAYS = 365; // expiresAt = now + 365d, well outside any window

test('stopMonitoring removes persisted reply + bulk schedules for the sheet', async () => {
  // Seed BOTH schedule files via the modules' own register API so the
  // on-disk entry shape is exactly what the real campaign loop writes.
  await replyMod.registerReplySchedule({
    sheetId: SHEET_ID,
    sheetUrl: SHEET_URL,
    profileId: PROFILE_ID,
    profileName: 'Acct One',
    linkedinColumn: 'Linkedin URL',
    days: FAR_FUTURE_DAYS,
  });
  await bulkMod.registerSchedule({
    sheetId: SHEET_ID,
    sheetUrl: SHEET_URL,
    profileId: PROFILE_ID,
    profileName: 'Acct One',
    linkedinColumn: 'Linkedin URL',
    days: FAR_FUTURE_DAYS,
  });

  // Sanity: both files now hold a SHEET123 entry before we stop.
  const replyBefore = await replyMod.listSchedule();
  const bulkBefore = await bulkMod.listSchedule();
  assert.ok(
    replyBefore.some((e) => e.sheetId === SHEET_ID),
    'precondition: reply schedule should hold a SHEET123 entry',
  );
  assert.ok(
    bulkBefore.some((e) => e.sheetId === SHEET_ID),
    'precondition: bulk schedule should hold a SHEET123 entry',
  );

  // Put the campaign into the monitoring state the operator stops from.
  campaign.state = 'monitoring';
  campaign.sheetUrl = SHEET_URL;
  campaign.participatingProfileIds = [PROFILE_ID];

  const res = await stopMonitoring({ reason: 'test' });
  assert.equal(res.ok, true, 'stopMonitoring should succeed');

  // The chip reads these files — after stop there must be NO SHEET123 entry
  // in either, or the dashboard keeps showing "● Monitoring · N days".
  const replyAfter = await replyMod.listSchedule();
  const bulkAfter = await bulkMod.listSchedule();
  assert.ok(
    !replyAfter.some((e) => e.sheetId === SHEET_ID),
    'reply schedule must not contain a SHEET123 entry after stopMonitoring',
  );
  assert.ok(
    !bulkAfter.some((e) => e.sheetId === SHEET_ID),
    'bulk schedule must not contain a SHEET123 entry after stopMonitoring',
  );
});
