import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for the v2.77→2.90 in-app update bug.
//
// The release DMG ships TWO bundles: "Ortus Outreach Setup.app" (the Gatekeeper
// unlock helper) and "The Ortus Outreach.app" (the real app). The one-click
// auto-updater (server.js) copies the app it finds in the mounted DMG. The
// original selector — `ls "$MNT/"*.app | head -1` — returns the ALPHABETICALLY
// first bundle, which is "Ortus Outreach Setup.app" (O sorts before T). The
// updater therefore installed the tiny Setup helper OVER the real app and
// relaunched it ("Setup complete. Launching…" dialog), forcing operators to
// reinstall from the terminal. install-mac.sh always copied by explicit name,
// which is why the terminal installer was immune.
//
// The fix selects "The Ortus Outreach.app" by explicit name, mirroring
// install-mac.sh. These tests lock that in.

const __dirname = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

test('updater selects the real app by explicit name', () => {
  assert.match(
    server,
    /SRC="\$MNT\/The Ortus Outreach\.app"/,
    'the update-install script must pick "The Ortus Outreach.app" by explicit name',
  );
});

test('any "ls *.app | head -1" is only a last-resort fallback, never the primary selector', () => {
  const idxExplicit = server.indexOf('SRC="$MNT/The Ortus Outreach.app"');
  assert.ok(idxExplicit !== -1, 'explicit-name selection must be present');
  const idxHead1 = server.indexOf('*.app 2>/dev/null | head -1)', idxExplicit);
  // head -1 may survive as a guarded fallback, but only AFTER the explicit pick.
  assert.ok(
    idxHead1 === -1 || idxHead1 > idxExplicit,
    'a bare "head -1" .app selector must not precede the explicit-name selection',
  );
});
