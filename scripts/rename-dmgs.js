#!/usr/bin/env node
// Rename electron-builder's DMG outputs to the stable names the install
// wizard expects:
//   Ortus-Outreach-x64.dmg   → Ortus-Outreach-intel.dmg
//   Ortus-Outreach-arm64.dmg → (already correct)
//
// The install wizard in the master sheet has hard-coded URLs:
//   releases/latest/download/Ortus-Outreach-arm64.dmg
//   releases/latest/download/Ortus-Outreach-intel.dmg
// Updating that wizard requires Apps Script access the user does not have,
// so the build pipeline MUST emit those exact filenames.

import { renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
const renames = [
  ['Ortus-Outreach-x64.dmg', 'Ortus-Outreach-intel.dmg'],
];

for (const [from, to] of renames) {
  const src = resolve(dist, from);
  const dst = resolve(dist, to);
  if (existsSync(src)) {
    renameSync(src, dst);
    console.log(`[rename-dmgs] ${from} → ${to}`);
  } else if (existsSync(dst)) {
    console.log(`[rename-dmgs] ${to} already in place`);
  } else {
    console.warn(`[rename-dmgs] ⚠ neither ${from} nor ${to} found in dist/`);
  }
}
