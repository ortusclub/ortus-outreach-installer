#!/usr/bin/env node
// scripts/capture-voyager-fixture.mjs
//
// One-shot utility for capturing a real Voyager `/messaging/conversations`
// response into `tests/fixtures/voyager-conversations-real.json`.
//
// This is the reproducible way to regenerate the Phase 11 Wave 0 contract
// fixture whenever LinkedIn rotates the response schema.
//
// Usage:
//   node scripts/capture-voyager-fixture.mjs <gologin-profile-id>
//
// Requirements:
//   - A GoLogin profile that has an active, logged-in LinkedIn session
//   - GOLOGIN_TOKEN available in the environment (or in `.env`)
//   - At least one DM thread on the account so the response isn't empty
//
// The script:
//   1. Launches the GoLogin profile via src/gologin-launcher.js::launchProfile
//   2. Navigates to https://www.linkedin.com/feed/ so the session is active
//   3. Runs a page.evaluate that performs the exact Voyager fetch described
//      in 11-RESEARCH.md §Pattern 1 (URL, headers, credentials).
//   4. Pretty-prints the JSON response to tests/fixtures/voyager-conversations-real.json
//   5. Logs the HTTP status + timing to stderr.
//   6. Closes the profile on both success AND error (try/finally).

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { launchProfile, closeProfile } from '../src/gologin-launcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const OUTPUT = resolve(__dirname, '..', 'tests', 'fixtures', 'voyager-conversations-real.json');

async function main() {
  const profileId = process.argv[2];
  if (!profileId) {
    console.error('Usage: node scripts/capture-voyager-fixture.mjs <gologin-profile-id>');
    process.exit(2);
  }

  const token = process.env.GOLOGIN_API_TOKEN || process.env.GOLOGIN_TOKEN;
  if (!token) {
    console.error('Missing GOLOGIN_API_TOKEN (or GOLOGIN_TOKEN) in environment.');
    process.exit(2);
  }

  console.error(`[capture-voyager] Launching profile ${profileId}…`);
  const startedAt = Date.now();
  let launched;
  try {
    launched = await launchProfile(profileId, token);
  } catch (err) {
    console.error(`[capture-voyager] Failed to launch profile: ${err.message}`);
    process.exit(3);
  }

  const { page } = launched;

  try {
    console.error('[capture-voyager] Navigating to linkedin.com/feed/ …');
    try {
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (navErr) {
      console.error(`[capture-voyager] Warning — feed nav: ${navErr.message}`);
    }

    // Give the session a beat to settle cookies / CSRF.
    await new Promise(r => setTimeout(r, 3000));

    console.error('[capture-voyager] Running Voyager fetch inside page context…');
    const tFetchStart = Date.now();
    const result = await page.evaluate(async () => {
      try {
        const csrf = document.cookie
          .split(';')
          .map(c => c.trim())
          .find(c => c.startsWith('JSESSIONID='));
        if (!csrf) return { ok: false, error: 'no_jsessionid' };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const url = 'https://www.linkedin.com/voyager/api/messaging/conversations'
          + '?keyVersion=LEGACY_INBOX&count=20&start=0';

        const resp = await fetch(url, {
          headers: {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
            'x-li-lang': 'en_US',
          },
          credentials: 'include',
        });

        const status = resp.status;
        let data = null;
        let textBody = null;
        try {
          data = await resp.json();
        } catch (jsonErr) {
          try { textBody = await resp.text(); } catch { /* ignore */ }
          return { ok: false, status, url, error: 'invalid_json', textPreview: (textBody || '').slice(0, 500) };
        }
        if (!resp.ok) return { ok: false, status, url, data };
        return { ok: true, status, url, data };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
    const fetchMs = Date.now() - tFetchStart;

    if (!result || !result.ok) {
      console.error(`[capture-voyager] Fetch failed after ${fetchMs}ms: ${JSON.stringify(result)}`);
      process.exit(4);
    }

    console.error(`[capture-voyager] HTTP ${result.status} in ${fetchMs}ms`);

    const pretty = JSON.stringify(result.data, null, 2);
    await writeFile(OUTPUT, pretty, 'utf8');
    const bytes = Buffer.byteLength(pretty, 'utf8');
    console.error(`[capture-voyager] Wrote ${bytes} bytes to ${OUTPUT}`);
    console.error(`[capture-voyager] Done in ${Date.now() - startedAt}ms`);
  } finally {
    try {
      await closeProfile(profileId);
      console.error('[capture-voyager] Profile closed.');
    } catch (closeErr) {
      console.error(`[capture-voyager] Warning — close failed: ${closeErr.message}`);
    }
  }
}

main().catch(err => {
  console.error(`[capture-voyager] Fatal: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
