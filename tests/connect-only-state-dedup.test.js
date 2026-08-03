// connect_only must trust the SHEET, on both sides of the run.
//
// Its pre-filter reads the Stage column and nothing else, so pre-flight counted
// rows the in-loop picker then dropped against local state.json. Field report
// 2026-08-03: 431 eligible, 1 sent, 430 silently blocked by a file the operator
// can't see — and since the memory is keyed by LinkedIn URL, moving the leads
// to a brand new spreadsheet changed nothing. CC+IC and CC+DM were already
// exempt for exactly this reason; connect_only is the same cold-lead flow.
//
// The picker lives ~1000 lines inside startCampaign with no seam to call it
// from a test, so this pins the contract at the source level (repo convention —
// see board-tick-selector.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/campaign.js'), 'utf8');

// The one condition that gates local-state dedup, isolated so an unrelated
// `state.processed[...]` read elsewhere can't satisfy these assertions.
const guard = (() => {
  const m = src.match(/if \(mode !== 'message_only'[^)]*state\.processed\[candidateUrl\]\) \{/);
  assert.ok(m, 'the in-loop ALREADY_PROCESSED guard must exist');
  return m[0];
})();

test('every cold-lead connect mode is exempt from local-state dedup', () => {
  // All three send a first-touch invite off a sheet the operator curates. If
  // one of them consults state.processed and its pre-filter does not, the run
  // reports rows as eligible and then drops them.
  for (const mode of ['connect_only', 'connect_and_introduce', 'connect_and_message']) {
    assert.match(guard, new RegExp(`mode !== '${mode}'`), `${mode} must be exempt`);
  }
});

test('modes that legitimately re-touch a row stay exempt', () => {
  for (const mode of ['message_only', 'introduce_back', 'open_profile_only']) {
    assert.match(guard, new RegExp(`mode !== '${mode}'`), `${mode} must stay exempt`);
  }
});

test('exhaustion reports the skip reasons instead of going quiet', () => {
  assert.match(
    src,
    /log\(`All leads processed or filtered out\.\$\{summarizeSkips\(getSkips\(\)\)\}`\)/,
    'the exhaustion line must carry the skip summary',
  );
});
