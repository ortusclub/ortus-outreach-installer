import test from 'node:test';
import assert from 'node:assert/strict';
import { isSystemTabName, looksLikeLeadRows } from '../src/sheets.js';

test('isSystemTabName flags known system tabs (case-insensitive)', () => {
  ['Recent Connections','recent messages','SavedSearch/Batches','SoO','LinkedIn Accounts','Ops Log','Events','Config']
    .forEach(n => assert.equal(isSystemTabName(n), true, n));
  assert.equal(isSystemTabName('HTECHxDELLxINT leads'), false);
});

test('looksLikeLeadRows requires First Name + a LinkedIn URL column', () => {
  const lead = [{ 'First Name':'Ryan','Last Name':'Rooijen','LinkedIn URL':'https://www.linkedin.com/in/ACwAAADy' }];
  assert.equal(looksLikeLeadRows(lead), true);
  const sys = [{ Account:'a@x.com','First Name':'Adriano','Last Name':'Lucchesi','Public ID':'adriano','Connected At':'…' }];
  assert.equal(looksLikeLeadRows(sys), false);  // no LinkedIn URL column
  assert.equal(looksLikeLeadRows([]), false);
});
