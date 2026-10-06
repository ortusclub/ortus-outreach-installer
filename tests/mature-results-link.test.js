import test from 'node:test';
import assert from 'node:assert/strict';
import { matureResultsLink, MATURE_RESULTS_WORKBOOK_ID as id } from '../public/js/mature-results-link.mjs';
test('legacy spreadsheet links resolve to the shared workbook and flag unmigrated results', () => {
  const result = matureResultsLink('https://docs.google.com/spreadsheets/d/1Gc2nwQcZXbguYnPWLGQCgVrKGG71gpHpHqMIezbmdQw/edit?gid=0#gid=0');
  assert.equal(result.url, `https://docs.google.com/spreadsheets/d/${id}/edit`);
  assert.equal(result.legacy, true);
});
test('account tab is preserved only within the configured shared workbook', () => {
  assert.equal(matureResultsLink(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=1906024847`).url, `https://docs.google.com/spreadsheets/d/${id}/edit#gid=1906024847`);
  assert.equal(matureResultsLink().legacy, false);
  assert.equal(matureResultsLink('javascript:alert(1)').url, matureResultsLink().url);
});
