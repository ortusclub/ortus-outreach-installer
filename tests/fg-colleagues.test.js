// tests/fg-colleagues.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __setFgColleaguesFixtures, listFgColleagues } from '../src/connections/search-service.js';

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
