import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSheetGid, spreadsheetIdFromUrl, withGid } from '../src/utils.js';

test('spreadsheetIdFromUrl pulls the /d/<id>/ segment', () => {
  assert.equal(
    spreadsheetIdFromUrl('https://docs.google.com/spreadsheets/d/1GHILabc/edit?gid=5#gid=5'),
    '1GHILabc');
  assert.equal(spreadsheetIdFromUrl('not a url'), '');
});

test('extractSheetGid handles #gid=, ?gid=, &gid=', () => {
  assert.equal(extractSheetGid('…/edit#gid=1249624821'), '1249624821');
  assert.equal(extractSheetGid('…/edit?gid=42'), '42');
  assert.equal(extractSheetGid('…/edit'), '');
});

test('withGid guarantees the gid in the URL, replacing any existing one', () => {
  const u = 'https://docs.google.com/spreadsheets/d/1GHILabc/edit';
  assert.match(withGid(u, '99'), /[?#]gid=99/);
  assert.match(withGid('…/edit#gid=1', '99'), /gid=99/);
  assert.doesNotMatch(withGid('…/edit#gid=1', '99'), /gid=1\b/);
  assert.equal(withGid(u, ''), u); // no gid → unchanged
});
