#!/usr/bin/env node
// Publish the macOS DMGs to GitHub Releases under stable filenames the
// install wizard expects. The wizard's URLs are hard-coded and outside the
// build pipeline's reach, so this script ensures every release surfaces
// assets at exactly:
//   releases/latest/download/Ortus-Outreach-arm64.dmg
//   releases/latest/download/Ortus-Outreach-intel.dmg
//
// Usage: `npm run release:mac` (after a working `electron:build:mac`).

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = 'ortusclub/ortus-outreach-installer';
const dist = resolve('dist');

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const tag = `v${pkg.version}`;

const arm = resolve(dist, 'Ortus-Outreach-arm64.dmg');
const intel = resolve(dist, 'Ortus-Outreach-intel.dmg');

for (const f of [arm, intel]) {
  if (!existsSync(f)) {
    console.error(`[release-mac] missing ${f} — run npm run electron:build:mac first.`);
    process.exit(1);
  }
}

function sh(cmd) {
  console.log(`+ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

const releaseExists = (() => {
  try { execSync(`gh release view ${tag} -R ${REPO}`, { stdio: 'pipe' }); return true; }
  catch { return false; }
})();

if (releaseExists) {
  console.log(`[release-mac] release ${tag} exists — uploading assets with --clobber`);
  sh(`gh release upload ${tag} -R ${REPO} --clobber "${arm}" "${intel}"`);
} else {
  const notes = `Ortus Outreach ${pkg.version}\n\nDownloads:\n- Apple Silicon: Ortus-Outreach-arm64.dmg\n- Intel Mac: Ortus-Outreach-intel.dmg`;
  sh(`gh release create ${tag} -R ${REPO} --title "Ortus Outreach ${pkg.version}" --notes "${notes.replace(/"/g, '\\"')}" "${arm}" "${intel}"`);
}

console.log(`\n✓ Released ${tag}. Stable URLs:`);
console.log(`  https://github.com/${REPO}/releases/latest/download/Ortus-Outreach-arm64.dmg`);
console.log(`  https://github.com/${REPO}/releases/latest/download/Ortus-Outreach-intel.dmg`);
