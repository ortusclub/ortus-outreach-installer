import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractProfileUrnFromVoyagerResponse } from '../src/linkedin/helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(
  join(__dirname, 'fixtures/voyager-identity-profile-success.json'),
  'utf8'
));

test('extractProfileUrnFromVoyagerResponse: returns urn from top-level entityUrn', () => {
  const urn = extractProfileUrnFromVoyagerResponse(fixture);
  assert.equal(urn, 'urn:li:fsd_profile:ACoAACa0cGUBIFz763pB0KKaLKszka94Bw35fyo');
});

test('extractProfileUrnFromVoyagerResponse: returns urn from data.entityUrn', () => {
  const data = { data: { entityUrn: 'urn:li:fsd_profile:ACoAAExample123' } };
  assert.equal(extractProfileUrnFromVoyagerResponse(data), 'urn:li:fsd_profile:ACoAAExample123');
});

test('extractProfileUrnFromVoyagerResponse: returns urn from included[] when top-level is collection envelope', () => {
  const data = {
    entityUrn: 'urn:li:collectionResponse:foo',
    included: [
      { entityUrn: 'urn:li:somethingElse:noise' },
      { entityUrn: 'urn:li:fsd_profile:ACoAATargetXyz', publicIdentifier: 'target' },
    ],
  };
  assert.equal(extractProfileUrnFromVoyagerResponse(data), 'urn:li:fsd_profile:ACoAATargetXyz');
});

test('extractProfileUrnFromVoyagerResponse: returns empty string when no profile urn anywhere', () => {
  assert.equal(extractProfileUrnFromVoyagerResponse({}), '');
  assert.equal(extractProfileUrnFromVoyagerResponse({ entityUrn: 'urn:li:other:foo' }), '');
  assert.equal(extractProfileUrnFromVoyagerResponse(null), '');
});

test('extractProfileUrnFromVoyagerResponse: accepts fs_miniProfile and fs_profile prefixes', () => {
  assert.equal(
    extractProfileUrnFromVoyagerResponse({ entityUrn: 'urn:li:fs_miniProfile:ACoAAMini' }),
    'urn:li:fs_miniProfile:ACoAAMini'
  );
  assert.equal(
    extractProfileUrnFromVoyagerResponse({ entityUrn: 'urn:li:fs_profile:ACoAAOld' }),
    'urn:li:fs_profile:ACoAAOld'
  );
});
