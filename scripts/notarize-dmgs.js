#!/usr/bin/env node
// Notarize + staple the built DMGs, when (and only when) credentials exist.
//
// Signing alone does NOT stop the "damaged / unidentified developer" warning on
// a colleague's Mac — Gatekeeper wants a notarization ticket too. So the build
// signs (electron-builder, from the Developer ID cert in the keychain) and this
// staples the ticket on afterwards.
//
// No credentials → no-op, and the build still produces working unsigned DMGs
// exactly as it does today. Nothing here can fail a build that used to pass.
//
// Required env (all three):
//   APPLE_ID                       Apple account email on the Developer Program
//   APPLE_APP_SPECIFIC_PASSWORD    appleid.apple.com → Sign-In and Security →
//                                  App-Specific Passwords (NOT the account password)
//   APPLE_TEAM_ID                  10-char Team ID from developer.apple.com/account

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;

if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
  console.log('[notarize] no Apple credentials in env — skipping (DMGs ship unsigned/unstapled)');
  process.exit(0);
}

const dmgs = ['Ortus-Outreach-arm64.dmg', 'Ortus-Outreach-intel.dmg']
  .map((n) => resolve('dist', n))
  .filter(existsSync);

if (!dmgs.length) {
  console.error('[notarize] no DMGs in dist/ — run the build first.');
  process.exit(1);
}

const run = (args, opts = {}) => execFileSync('xcrun', args, { encoding: 'utf8', ...opts });

for (const dmg of dmgs) {
  // An unsigned DMG is rejected by notarytool with a message nobody can act on,
  // so check first and say the actual cause.
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', dmg], { stdio: 'pipe' });
  } catch {
    console.error(`[notarize] ${dmg} is not signed — install a "Developer ID Application" certificate in the login keychain and rebuild. Nothing submitted.`);
    process.exit(1);
  }

  console.log(`[notarize] submitting ${dmg} (this waits on Apple, typically 2-10 min)…`);
  // Credentials go in as argv to xcrun, never logged by this script.
  run([
    'notarytool', 'submit', dmg,
    '--apple-id', APPLE_ID,
    '--password', APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id', APPLE_TEAM_ID,
    '--wait',
  ], { stdio: 'inherit' });

  run(['stapler', 'staple', dmg], { stdio: 'inherit' });
  console.log(`[notarize] ✓ stapled ${dmg}`);
}
