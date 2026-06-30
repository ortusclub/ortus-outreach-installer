// tests/fg-colleagues.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __setFgColleaguesFixtures, listFgColleagues, listFgColleaguesMatched } from '../src/connections/search-service.js';

test('listFgColleagues returns distinct owners with non-DNC connection counts, sorted by name', () => {
  __setFgColleaguesFixtures({
    annotated: [
      { contact: { firstname: 'A' }, warmVia: ['bea@ortusclub.com'], dnc: false },
      { contact: { firstname: 'B' }, warmVia: ['bea@ortusclub.com', 'sam@ortusclub.com'], dnc: false },
      { contact: { firstname: 'C' }, warmVia: ['sam@ortusclub.com'], dnc: true }, // DNC excluded
    ],
    colleagues: {
      'bea@ortusclub.com': { name: 'Beatrice Talusan' },
      'sam@ortusclub.com': { name: 'Sam Adcock' },
    },
  });
  const out = listFgColleagues();
  assert.deepEqual(out, [
    { email: 'bea@ortusclub.com', name: 'Beatrice Talusan', connCount: 2 },
    { email: 'sam@ortusclub.com', name: 'Sam Adcock', connCount: 1 },
  ]);
});

test('listFgColleaguesMatched counts matched (role keywords) and total per owner', () => {
  __setFgColleaguesFixtures({
    annotated: [
      { contact: { firstname: 'A', jobtitle: 'Head of Marketing' }, warmVia: ['bea@ortusclub.com'], dnc: false },
      { contact: { firstname: 'B', jobtitle: 'Engineer' },          warmVia: ['bea@ortusclub.com', 'sam@ortusclub.com'], dnc: false },
      { contact: { firstname: 'C', jobtitle: 'Brand Lead' },        warmVia: ['sam@ortusclub.com'], dnc: false },
      { contact: { firstname: 'D', jobtitle: 'CMO' },               warmVia: ['sam@ortusclub.com'], dnc: true }, // DNC excluded from both
    ],
    colleagues: { 'bea@ortusclub.com': { name: 'Beatrice' }, 'sam@ortusclub.com': { name: 'Sam' } },
  });
  const out = listFgColleaguesMatched(['marketing', 'brand']);
  assert.deepEqual(out, [
    { email: 'bea@ortusclub.com', name: 'Beatrice', total: 2, matched: 1 }, // A matches, B not
    { email: 'sam@ortusclub.com', name: 'Sam', total: 2, matched: 1 },      // C matches, B not, D dnc
  ]);
});

test('listFgColleaguesMatched subtracts already-invited from matched (not total)', () => {
  __setFgColleaguesFixtures({
    annotated: [
      { contact: { firstname: 'A', jobtitle: 'Head of Marketing', linkedin_membership_id: 'm1' }, warmVia: ['bea@ortusclub.com'], dnc: false },
      { contact: { firstname: 'B', jobtitle: 'Brand Lead', linkedin_membership_id: 'm2' }, warmVia: ['bea@ortusclub.com'], dnc: false },
    ],
    colleagues: { 'bea@ortusclub.com': { name: 'Beatrice' } },
  });
  const out = listFgColleaguesMatched(['marketing', 'brand'], { alreadyInvited: ['m1'] });
  assert.deepEqual(out, [
    { email: 'bea@ortusclub.com', name: 'Beatrice', total: 2, matched: 1 }, // m1 already invited → excluded from matched
  ]);
});

test('listFgColleaguesMatched with no keywords => matched equals total', () => {
  __setFgColleaguesFixtures({
    annotated: [
      { contact: { firstname: 'A', jobtitle: 'Anything' }, warmVia: ['bea@ortusclub.com'], dnc: false },
      { contact: { firstname: 'B', jobtitle: '' },         warmVia: ['bea@ortusclub.com'], dnc: false },
    ],
    colleagues: { 'bea@ortusclub.com': { name: 'Beatrice' } },
  });
  const out = listFgColleaguesMatched([]);
  assert.deepEqual(out, [{ email: 'bea@ortusclub.com', name: 'Beatrice', total: 2, matched: 2 }]);
});
