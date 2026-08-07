#!/usr/bin/env node
// scripts/enrich-guests.mjs
//
// Fills in guest profile photos (and headlines) for the door check-in tool.
//
// The check-in app already knows each guest's LinkedIn slug — it comes off the
// event sheet's `Accepted` tab. What it can't do is fetch the photo: that needs
// an authenticated LinkedIn session in a real browser. So we do it here, in a
// logged-in GoLogin profile, and hand the result to the check-in Apps Script.
//
// This is a plain script. The Ortus Outreach dashboard does NOT need to be
// running — it only borrows that project's node_modules and its GoLogin
// launcher.
//
// Usage:
//   node scripts/enrich-guests.mjs --tag=KIZ_LA_I
//   node scripts/enrich-guests.mjs --tag=KIZ_LA_I --limit=25
//   node scripts/enrich-guests.mjs --watch          ← serves the door tool's button
//
// Environment (put these in .env):
//   GOLOGIN_API_TOKEN   — same token the campaigns use
//   CHECKIN_API_URL     — the check-in web app /exec URL
//   CHECKIN_TOKEN       — the check-in shared secret
//
// Options:
//   --tag=<EVENT_TAG>   required, unless --watch
//   --watch             poll the sheet's `Photo Requests` tab forever and run
//                       whatever the door tool's "Fetch photos" button asks for
//   --every=<seconds>   watch poll interval (default 30)
//   --account=<email>   GoLogin profile name; defaults to ACCOUNT below
//   --limit=<n>         stop after n profiles (default: all pending)
//   --delay=<seconds>   base pause between profiles (default 6)
//   --dry               skip the write-back only. This still opens every profile
//                       and still spends LinkedIn views — use --limit to go small.
//
// Re-running is safe and cheap: the server only hands back guests it has no
// cached photo for, so a second run picks up whatever failed the first time.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { getProfiles, launchProfile, closeProfile } from '../src/gologin-launcher.js';
import { extractProfile } from './lib/voyager-photo.mjs';

// Which LinkedIn account does the looking. ENRICH_ACCOUNT in .env wins; --account
// overrides per run. Whichever it is must be signed in inside GoLogin.
const ACCOUNT   = process.env.ENRICH_ACCOUNT || 'pavan.p@ortus.solutions';
const BATCH     = 10;     // push to the sheet every N guests, so a crash doesn't lose the run
const NAV_MS    = 30000;
const SETTLE_MS = 2000;   // let LinkedIn's client-side redirect finish before we read the page

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? true : fallback;
}

const TAG     = arg('tag', '');
const EMAIL   = arg('account', ACCOUNT);
const LIMIT   = Number(arg('limit', 0)) || 0;
const DELAY   = (Number(arg('delay', 6)) || 6) * 1000;
const DRY     = !!arg('dry', false);

const API   = process.env.CHECKIN_API_URL;
const TOKEN = process.env.CHECKIN_TOKEN;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Jitter the gap between profiles. A metronome-steady 6.0s request pattern is
// exactly what rate-limiting looks for.
const pause = () => sleep(DELAY + Math.floor(Math.random() * DELAY));

/**
 * Apps Script intermittently answers with a Google error page ("Pagina non
 * trovata") instead of running the script — roughly one call in three, and it
 * succeeds on the next attempt. Every call to it needs this retry; losing a
 * finished batch of photos to a hiccup would mean re-viewing those profiles.
 */
async function checkinCall(label, doFetch, tries = 4) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await doFetch();
      const text = await res.text();
      if (text.trim().startsWith('{')) {
        const json = JSON.parse(text);
        if (json.ok === false) throw new Error(`${label}: ${json.error}`);
        return json;
      }
      last = new Error(`${label}: got an HTML error page, not JSON (status ${res.status})`);
    } catch (err) {
      // A real error from the script itself won't fix itself on a retry.
      if (/^\w+: /.test(err.message) && !/HTML error page/.test(err.message)) throw err;
      last = err;
    }
    if (i < tries) await sleep(1500 * i);
  }
  throw last;
}

const checkinGet = params => checkinCall('check-in fetch',
  () => fetch(`${API}?token=${encodeURIComponent(TOKEN)}&${params}`));

// text/plain keeps the browser-style preflight off Apps Script's back; Node
// doesn't preflight, but the endpoint is shared with the web app so we match.
const checkinPost = body => checkinCall('check-in save',
  () => fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, token: TOKEN }),
  }));

/**
 * About half the LinkedIn URLs on an Accepted tab are the encoded
 * `/in/ACwAA…` form rather than a vanity slug. Voyager's `memberIdentity`
 * only accepts the slug — handed an encoded id it answers 403 "This profile
 * can't be accessed", which reads like a privacy block and isn't one.
 *
 * The browser resolves it for us: navigating to the encoded URL lands on the
 * real one, so we read the slug back out of the address bar.
 */
/**
 * Restore the profile's LinkedIn session by hand.
 *
 * The SDK seeds the browser from `profile.cookies.cookies` on
 * `/browser/features/<id>/info-for-run`, and on this machine that array comes
 * back EMPTY — the cookies are supposed to arrive inside the downloaded profile
 * archive, which isn't unpacking (the giveaway is the ENOENT on
 * `Default/Bookmarks` during launch). Net effect: a logged-out browser for an
 * account that is perfectly well logged in.
 *
 * `/browser/<id>/cookies` still serves the real jar, so we inject it ourselves.
 * These are the profile's own cookies, going back into the profile's own
 * browser — the same thing the SDK intended to do.
 */
async function restoreCookies(page, profileId, glToken) {
  const res = await fetch(`https://api.gologin.com/browser/${profileId}/cookies`, {
    headers: { Authorization: `Bearer ${glToken}` },
  });
  if (!res.ok) return { ok: false, reason: `cookies API ${res.status}` };

  const sameSite = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };
  const jar = (await res.json())
    .filter(c => c && c.name && /linkedin/i.test(c.domain || ''))
    .map(c => {
      const out = {
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        httpOnly: !!c.httpOnly, secure: !!c.secure,
      };
      // Chromium rejects the whole cookie on an unknown sameSite, so only send
      // one we recognise.
      const ss = sameSite[String(c.sameSite || '').toLowerCase()];
      if (ss) out.sameSite = ss;
      if (c.expirationDate) out.expires = Math.floor(c.expirationDate);
      return out;
    });

  if (!jar.length) return { ok: false, reason: 'no LinkedIn cookies stored for this profile' };
  await page.setCookie(...jar);
  return { ok: true, count: jar.length };
}

/** `voyager/api/me` returns the viewing member — the cheapest proof that this
 *  profile still holds a live LinkedIn session. */
async function checkSession(page, probeUrl) {
  try {
    return await visit(page, probeUrl, async () => {
      if (/\/(login|uas|checkpoint|authwall)/.test(window.location.pathname)) {
        return { ok: false, reason: 'redirected to ' + window.location.pathname };
      }
      const csrf = document.cookie.split(';').map(c => c.trim())
        .find(c => c.startsWith('JSESSIONID='));
      if (!csrf) return { ok: false, reason: 'no JSESSIONID cookie' };
      const resp = await fetch('https://www.linkedin.com/voyager/api/me', {
        headers: {
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': csrf.split('=')[1]?.replace(/"/g, ''),
          'x-restli-protocol-version': '2.0.0',
        },
        credentials: 'include',
      });
      if (!resp.ok) return { ok: false, reason: 'voyager/me returned ' + resp.status };
      const body = await resp.json();
      const mini = body?.included?.find(i => i && (i.firstName || i.publicIdentifier)) || {};
      return { ok: true, name: [mini.firstName, mini.lastName].filter(Boolean).join(' ') || 'unknown' };
    });
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
}

/** Everything that happens inside the page, in ONE evaluate. Reading the
 *  resolved slug and doing the Voyager fetch used to be two round-trips, which
 *  doubled the window in which a redirect could kill the context underneath us. */
function inPage(fallbackSlug) {
  return async (fallback) => {
    // The encoded URL has already redirected by now, so the address bar holds
    // the real vanity slug.
    const m = window.location.pathname.match(/\/in\/([^/]+)/);
    const publicId = m ? decodeURIComponent(m[1]) : fallback;

    const csrf = document.cookie.split(';').map(c => c.trim())
      .find(c => c.startsWith('JSESSIONID='));
    if (!csrf) return { error: 'no-csrf', publicId };
    const token = csrf.split('=')[1]?.replace(/"/g, '');

    const url = 'https://www.linkedin.com/voyager/api/identity/dash/profiles'
      + '?q=memberIdentity&memberIdentity=' + encodeURIComponent(publicId)
      + '&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-7';
    try {
      const resp = await fetch(url, {
        headers: {
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': token,
          'x-restli-protocol-version': '2.0.0',
        },
        credentials: 'include',
      });
      if (!resp.ok) return { error: 'voyager-' + resp.status, publicId };
      return { data: await resp.json(), publicId };
    } catch (err) {
      return { error: String(err && err.message || err), publicId };
    }
  };
}

/**
 * About half the LinkedIn URLs on an Accepted tab are the encoded
 * `/in/ACwAA…` form rather than a vanity slug. Voyager's `memberIdentity`
 * only accepts the slug — handed an encoded id it answers 403 "This profile
 * can't be accessed", which reads like a privacy block and isn't one. The
 * browser resolves it for us, so we read the slug back out of the address bar.
 *
 * `domcontentloaded` fires before LinkedIn finishes its client-side redirect,
 * so evaluating straight away dies with "Execution context was destroyed".
 * The settle pause is the same one auto-intro.js uses for the same reason;
 * the retry covers the slow-machine case where 2s still isn't enough.
 */
async function fetchProfile(page, slug) {
  return visit(page, `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
    inPage(slug), slug);
}

/**
 * Navigate, let the page settle, then run `fn` inside it.
 *
 * `domcontentloaded` fires before LinkedIn finishes its client-side redirect,
 * so evaluating straight away dies with "Execution context was destroyed".
 * The settle pause is the same one auto-intro.js uses for the same reason; the
 * retry (with a longer settle) covers the slow-machine case, and the case where
 * freshly-injected cookies trigger a second redirect.
 */
async function visit(page, url, fn, arg) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Navigation errors are expected (a redirect aborts the first one); what
    // matters is where we end up, which `fn` reports.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }).catch(() => {});
    await sleep(SETTLE_MS * attempt);
    try {
      return await page.evaluate(fn, arg);
    } catch (err) {
      last = err;
      if (!/context was destroyed|Target closed|detached/i.test(String(err && err.message))) throw err;
    }
  }
  throw last;
}

async function flush(tag, rows, stats) {
  if (!rows.length) return;
  if (DRY) { rows.length = 0; return; }
  await checkinPost({ action: 'enrich', tag, rows: rows.slice() });
  stats.saved += rows.length;
  console.log(`   … saved ${rows.length} (${stats.saved} total)`);
  rows.length = 0;
}

function requireEnv() {
  if (!API || !TOKEN) throw new Error('CHECKIN_API_URL / CHECKIN_TOKEN missing from .env');
  const glToken = process.env.GOLOGIN_API_TOKEN || process.env.GOLOGIN_TOKEN;
  if (!glToken) throw new Error('GOLOGIN_API_TOKEN missing from .env');
  return glToken;
}

async function main() {
  if (!TAG) { console.error('Missing --tag=<EVENT_TAG>  (or use --watch)'); process.exit(2); }
  console.log(await run(TAG, EMAIL));
}

/** One event, start to finish. Returns the one-line summary.
 *  `onProgress` (optional) is called with each guest line, for watch mode. */
async function run(tag, email, onProgress = () => {}) {
  const glToken = requireEnv();

  console.log(`[enrich] ${tag} — asking the check-in sheet who still needs a photo…`);
  const queue = await checkinGet(`action=enrich_queue&tag=${encodeURIComponent(tag)}`);
  let pending = queue.pending || [];
  console.log(`[enrich] ${queue.total} guests, ${pending.length} without a photo, ${queue.cached} already cached.`);
  if (!pending.length) return 'Nothing to fetch — everyone already has a photo.';
  if (LIMIT && pending.length > LIMIT) {
    console.log(`[enrich] --limit=${LIMIT}: doing the first ${LIMIT}, re-run for the rest.`);
    pending = pending.slice(0, LIMIT);
  }

  const profiles = await getProfiles(glToken);
  const profile = profiles.find(p => (p.name || '').toLowerCase() === email.toLowerCase());
  if (!profile) {
    throw new Error(`No GoLogin profile named "${email}"`);
  }

  // GoLogin's start call times out ("Request timeout after 13000ms") often enough
  // that a single attempt loses the whole run. Observed: fine, fail, fail, fine.
  console.log(`[enrich] Launching ${email}…`);
  let page;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      ({ page } = await launchProfile(profile.id, glToken));
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`[enrich] launch attempt ${attempt} failed (${err.message}) — retrying…`);
      await closeProfile(profile.id).catch(() => {});   // clear a half-started profile
      await sleep(10000 * attempt);
    }
  }

  // One cheap call before the loop. A logged-out profile answers 401 to every
  // Voyager request, so without this check a dead session looks like 21
  // individual guest failures and costs 21 profile views to discover.
  // Probe a real profile page, not /feed/ — a logged-out /feed/ bounces through
  // the login wall, and reading the page mid-bounce is what kept blowing up.
  const probeUrl = `https://www.linkedin.com/in/${encodeURIComponent(pending[0].slug)}/`;
  let who = await checkSession(page, probeUrl);
  if (!who.ok) {
    console.log(`[enrich] No session in the launched browser (${who.reason}) — restoring cookies from GoLogin…`);
    const restored = await restoreCookies(page, profile.id, glToken);
    if (restored.ok) {
      console.log(`[enrich] Injected ${restored.count} LinkedIn cookies.`);
      who = await checkSession(page, probeUrl);
    } else {
      who = { ok: false, reason: restored.reason };
    }
  }
  if (!who.ok) {
    await closeProfile(profile.id).catch(() => {});
    throw new Error(`${email} has no usable LinkedIn session (${who.reason}) — `
      + 'open that profile in GoLogin, sign in, then try again');
  }
  console.log(`[enrich] Session OK — signed in as ${who.name}.`);

  const stats = { ok: 0, noPhoto: 0, failed: 0, saved: 0 };
  const batch = [];
  try {
    for (let i = 0; i < pending.length; i++) {
      const g = pending[i];
      const label = `[${i + 1}/${pending.length}] ${g.name} (${g.slug})`;
      let outcome;                                  // what the door tool shows
      try {
        const res = await fetchProfile(page, g.slug);
        // Report where we actually landed — a 403 on an unresolved ACwAA id and
        // a 403 on a real slug are different problems.
        if (res.error) throw new Error(`${res.error} (as ${res.publicId})`);

        // Match on the resolved slug, but cache under the sheet's value —
        // that's the key the roster looks up.
        const found = extractProfile(res.data, res.publicId);
        if (!found) throw new Error('target profile not found in response');

        const row = { slug: g.slug, name: g.name, headline: found.headline };
        if (found.photoUrl) {
          row.photo = found.photoUrl;
          stats.ok++;
          outcome = `✓ ${g.name}`;
          console.log(`${label} ✓ photo + headline`);
        } else {
          // A real answer, not a failure: plenty of guests have no photo set.
          // Cache it so tomorrow's run doesn't try them again.
          row.noPhoto = true;
          stats.noPhoto++;
          outcome = `— ${g.name} · no photo on their profile`;
          console.log(`${label} — no photo on the profile`);
        }
        batch.push(row);
      } catch (err) {
        stats.failed++;
        outcome = `✗ ${g.name} · ${err.message}`;
        console.log(`${label} ✗ ${err.message}`);
      }
      onProgress({ done: i + 1, total: pending.length, line: outcome });

      if (batch.length >= BATCH) await flush(tag, batch, stats);
      if (i < pending.length - 1) await pause();
    }
    await flush(tag, batch, stats);
  } finally {
    await closeProfile(profile.id).catch(() => {});
  }

  const summary = `Done. ${stats.ok} with photos, ${stats.noPhoto} without, ${stats.failed} failed.`;
  console.log(`\n[enrich] ${summary}`);
  if (stats.failed) console.log('[enrich] Run it again to retry the failures.');
  if (DRY) console.log('[enrich] --dry: nothing was written.');
  return summary;
}

/**
 * Watch mode — the other half of the door tool's "Fetch photos" button.
 *
 * The check-in site is a static page and can't drive a browser, so its button
 * leaves a request in the sheet's `Photo Requests` tab and we come and collect
 * it. Nothing else needs to be running: no dashboard, no Electron, just this.
 *
 *   node scripts/enrich-guests.mjs --watch
 */
async function watch() {
  const every = (Number(arg('every', 30)) || 30) * 1000;
  console.log(`[watch] polling the check-in sheet every ${every / 1000}s as ${EMAIL}. Ctrl-C to stop.`);
  for (;;) {
    try {
      const { requests } = await checkinGet('action=photo_requests');
      const req = (requests || [])[0];
      if (req) {
        const tag = req.tag;
        console.log(`\n[watch] request for ${tag}`);
        await checkinPost({ action: 'photo_progress', tag, status: 'running',
                             note: 'Opening LinkedIn…' }).catch(() => {});
        try {
          /* Keep a short tail rather than the whole run: it's all the door tool
           * shows, and the sheet cell shouldn't grow without bound. */
          const tail = [];
          const summary = await run(tag, req.account || EMAIL, (p) => {
            tail.push(p.line);
            while (tail.length > 8) tail.shift();
            checkinPost({ action: 'photo_progress', tag, status: 'running',
                          done: p.done, total: p.total, note: tail.join('\n') }).catch(() => {});
          });
          await checkinPost({ action: 'photo_progress', tag, status: 'done', note: summary });
        } catch (err) {
          await checkinPost({ action: 'photo_progress', tag, status: 'failed',
                               note: err.message }).catch(() => {});
          console.log(`[watch] ${tag} failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.log(`[watch] ${err.message}`);   // a hiccup shouldn't kill the watcher
    }
    await sleep(every);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const job = arg('watch', false) ? watch() : main();
  job.catch(err => {
    console.error(`[enrich] ${err.message}`);
    process.exit(1);
  });
}
