import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanConnectionFilename } from '../../src/connections/drive-sync.js';

test('cleanConnectionFilename normalizes Drive titles to <email>.csv', () => {
  // plain
  assert.equal(cleanConnectionFilename('bea.talusan@ortus.solutions.csv'), 'bea.talusan@ortus.solutions.csv');
  // duplicate-export suffixes
  assert.equal(cleanConnectionFilename('valerie@ortus.solutions (1).csv'), 'valerie@ortus.solutions.csv');
  assert.equal(cleanConnectionFilename('joshua.m@ortusclub.com (2).csv'), 'joshua.m@ortusclub.com.csv');
  // " - connections" suffix
  assert.equal(cleanConnectionFilename('johnpaul.m@ortus.solutions - connections.csv'), 'johnpaul.m@ortus.solutions.csv');
  // trailing comma/space
  assert.equal(cleanConnectionFilename('taofeeq@ortus.solutions,.csv'), 'taofeeq@ortus.solutions.csv');
  // case-insensitive extension
  assert.equal(cleanConnectionFilename('Driton@oruts.solutions.CSV'), 'Driton@oruts.solutions.csv');
});

test('cleanConnectionFilename collapses duplicate exports to one name', () => {
  const a = cleanConnectionFilename('crestinal@ortus.solutions.csv');
  const b = cleanConnectionFilename('crestinal@ortus.solutions (1).csv');
  assert.equal(a, b); // both dedupe to the same canonical file
});
