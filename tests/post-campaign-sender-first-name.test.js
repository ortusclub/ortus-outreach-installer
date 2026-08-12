import { test } from 'node:test';
import assert from 'node:assert/strict';

import { senderFirstNamesFor } from '../src/post-campaign-bulk-check.js';

// The post-campaign sweep fires intros/DMs days after the campaign ended, from
// a schedule entry on disk. That entry never carried the operator's nice name,
// so runAutoIntros/runAutoDms fell through to `profileName.split(' ')[0]` —
// and profileName is the GoLogin label, i.e. the account email. Leads got
// "nabungaires@gmail.com here" instead of "Milee here". These lock the shape
// that carries the name across the gap.

test('a persisted name becomes the map keyed by profile id', () => {
  assert.deepEqual(
    senderFirstNamesFor({ profileId: 'p1', senderFirstName: 'Milee' }),
    { p1: 'Milee' },
  );
});

test('an entry written before this shipped degrades to the old fallback', () => {
  // No senderFirstName key at all — must be {} (send path then email-splits),
  // never a map holding undefined, which would render "undefined" in the DM.
  assert.deepEqual(senderFirstNamesFor({ profileId: 'p1' }), {});
});

test('whitespace is not a name', () => {
  assert.deepEqual(senderFirstNamesFor({ profileId: 'p1', senderFirstName: '   ' }), {});
});

test('a malformed entry never throws — the sweep must not die on it', () => {
  assert.deepEqual(senderFirstNamesFor(null), {});
  assert.deepEqual(senderFirstNamesFor({}), {});
  assert.deepEqual(senderFirstNamesFor({ senderFirstName: 'Milee' }), {}); // no profileId to key on
});
