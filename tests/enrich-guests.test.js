import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractProfile, bestArtifact } from '../scripts/lib/voyager-photo.mjs';

/** Voyager's `included` array carries more than the person you asked about.
 *  These fixtures pin down that we pick the guest, never the viewer. */
function profileEntity(slug, name, photoSeg) {
  return {
    entityUrn: `urn:li:fsd_profile:ACoAA${slug}`,
    publicIdentifier: slug,
    firstName: name.split(' ')[0],
    lastName: name.split(' ')[1] || '',
    headline: `${name}'s headline`,
    profilePicture: {
      displayImageReference: {
        vectorImage: {
          rootUrl: 'https://media.licdn.com/dms/image/',
          artifacts: [
            { width: 100, fileIdentifyingUrlPathSegment: `${photoSeg}-100` },
            { width: 400, fileIdentifyingUrlPathSegment: `${photoSeg}-400` },
            { width: 800, fileIdentifyingUrlPathSegment: `${photoSeg}-800` },
          ],
        },
      },
    },
  };
}

test('picks the guest, not the viewing account', () => {
  const data = { included: [
    profileEntity('judelyn-v', 'Judelyn Villaverde', 'viewer'),
    profileEntity('elena-boca', 'Elena Boca', 'guest'),
  ] };
  const got = extractProfile(data, 'elena-boca');
  assert.equal(got.name, 'Elena Boca');
  assert.match(got.photoUrl, /guest-400$/);
});

test('slug match is case-insensitive', () => {
  const data = { included: [profileEntity('elena-boca', 'Elena Boca', 'guest')] };
  assert.equal(extractProfile(data, 'Elena-Boca').name, 'Elena Boca');
});

test('refuses to guess when the slug is absent and several profiles have photos', () => {
  const data = { included: [
    { entityUrn: 'urn:li:fsd_profile:ACoAAa', ...profileEntity('a', 'A A', 'a'), publicIdentifier: undefined },
    { entityUrn: 'urn:li:fsd_profile:ACoAAb', ...profileEntity('b', 'B B', 'b'), publicIdentifier: undefined },
  ] };
  // Wrong face on a door badge is worse than no face.
  assert.equal(extractProfile(data, 'missing-slug'), null);
});

test('falls back to the single photo-bearing profile when the slug is absent', () => {
  const only = profileEntity('renamed', 'Only Person', 'only');
  delete only.publicIdentifier;
  const data = { included: [only, { entityUrn: 'urn:li:fsd_company:123' }] };
  assert.equal(extractProfile(data, 'old-slug').name, 'Only Person');
});

test('a profile with no picture yields an empty photo, not a throw', () => {
  const bare = { entityUrn: 'urn:li:fsd_profile:ACoAAx', publicIdentifier: 'bare',
                 firstName: 'Bare', lastName: 'Guest', headline: 'CFO' };
  const got = extractProfile({ included: [bare] }, 'bare');
  assert.equal(got.photoUrl, '');
  assert.equal(got.headline, 'CFO');
});

test('bestArtifact takes the smallest artifact at or above 400px', () => {
  const vec = { rootUrl: 'r/', artifacts: [
    { width: 800, fileIdentifyingUrlPathSegment: 'big' },
    { width: 100, fileIdentifyingUrlPathSegment: 'small' },
    { width: 400, fileIdentifyingUrlPathSegment: 'just-right' },
  ] };
  assert.equal(bestArtifact(vec), 'r/just-right');
});

test('bestArtifact settles for the largest when nothing reaches 400px', () => {
  const vec = { rootUrl: 'r/', artifacts: [
    { width: 100, fileIdentifyingUrlPathSegment: 'small' },
    { width: 200, fileIdentifyingUrlPathSegment: 'medium' },
  ] };
  assert.equal(bestArtifact(vec), 'r/medium');
});
