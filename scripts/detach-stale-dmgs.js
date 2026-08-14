#!/usr/bin/env node
// Detach leftover Ortus disk images before electron-builder runs.
//
// The v3.1.0 build died on:
//   hdiutil: resize: failed. Resource temporarily unavailable (35)
// hdiutil was still holding a half-built image from a previous run (and an
// old Ortus-Outreach-arm64.dmg the operator had mounted from Downloads).
// electron-builder retries the resize 5 times and then gives up — the retries
// can't help, because nothing releases the image on its own.
//
// So: eject ours before we start. Deliberately narrow — only images whose path
// looks like an Ortus DMG or an electron-builder temp image. Never anything
// else the operator has mounted.

import { execSync } from 'node:child_process';

const OURS = [
  /Ortus-Outreach.*\.dmg$/i,
  /The Ortus Outreach.*\.dmg$/i,
  // electron-builder's scratch image: /var/folders/…/T/t-XXXXXX/1.dmg
  /\/T\/t-[^/]+\/\d+\.dmg$/,
];

function attachedImages() {
  // -plist → plutil is the only parse of hdiutil output that isn't guesswork.
  const json = execSync('hdiutil info -plist | plutil -convert json -o - -', {
    encoding: 'utf8',
    shell: '/bin/sh',
  });
  const images = JSON.parse(json).images || [];
  return images.map((img) => ({
    path: img['image-path'] || '',
    // Any dev-entry detaches the whole image; the first is enough.
    dev: (img['system-entities'] || []).map((e) => e['dev-entry']).filter(Boolean)[0] || '',
  }));
}

let found = 0;
try {
  for (const img of attachedImages()) {
    if (!img.dev || !OURS.some((re) => re.test(img.path))) continue;
    found += 1;
    try {
      execSync(`hdiutil detach ${img.dev} -force`, { stdio: 'pipe' });
      console.log(`[detach-stale-dmgs] ejected ${img.dev} — ${img.path}`);
    } catch (e) {
      // Not fatal: the build may still succeed, and if it doesn't the hdiutil
      // error tells the operator more than a hard exit here would.
      console.warn(`[detach-stale-dmgs] ⚠ could not eject ${img.dev} (${img.path}): ${e.message.trim()}`);
    }
  }
} catch (e) {
  console.warn(`[detach-stale-dmgs] ⚠ skipped (${e.message.trim()})`);
}

if (!found) console.log('[detach-stale-dmgs] nothing of ours mounted — clean start');
