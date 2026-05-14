/**
 * Pre-flight verifier — checks the configured primary person can be reached
 * from a given sender account before any CC+IC connection requests go out.
 *
 * Returns one of:
 *   { ok: true,  canonicalName, candidates }
 *   { ok: false, failureType: 'url_invalid' | 'not_connected' | 'name_mismatch' | 'crash' | 'config' | 'session_expired' | 'render_timeout',
 *     canonicalName?, candidates?, detail }
 *
 * Spec: docs/superpowers/specs/2026-05-14-cc-ic-primary-person-preflight-design.md §4
 */

import { matchPrimaryCandidate } from './match-primary.js';

const PROFILE_NAV_TIMEOUT_MS = 15_000;
const TYPEAHEAD_POLL_ITER = 30;
const TYPEAHEAD_POLL_INTERVAL_MS = 200;

export async function verifyPrimaryPerson({
  page,
  profileName,
  primaryName,
  primaryUrl,
  log = console.log,
}) {
  if (!primaryName || !primaryUrl) {
    return { ok: false, failureType: 'config', detail: 'primaryName or primaryUrl missing' };
  }

  // ── Step 1: Visit primary URL ────────────────────────────────────────────
  try {
    await page.goto(primaryUrl, { waitUntil: 'domcontentloaded', timeout: PROFILE_NAV_TIMEOUT_MS });
  } catch (e) {
    log(`  [preflight:${profileName}] URL navigation failed: ${e.message}`);
    return { ok: false, failureType: 'url_invalid', detail: `Navigation failed: ${e.message}` };
  }
  // ── Wait for the profile content to render ───────────────────────────────
  // LinkedIn profile pages are a React SPA — the H1 with the name is NOT in
  // the initial HTML; React mounts it after domcontentloaded. Without this
  // wait, we read an empty DOM and mistake a still-rendering page for a
  // missing URL.
  try {
    await page.waitForFunction(() => {
      const h1 = document.querySelector('h1.text-heading-xlarge, main h1, h1');
      const text = (h1?.innerText || '').trim();
      return text.length > 2;
    }, { timeout: 10_000 });
  } catch {
    // Render didn't complete in 10s. Distinguish causes.
    const currentUrl = page.url();
    const signedOutByUrl = /\/login|\/authwall|\/checkpoint|\/uas\/login/i.test(currentUrl);
    const signedOutByContent = await page.evaluate(() => {
      const t = (document.title || '').toLowerCase();
      const b = (document.body?.innerText || '').toLowerCase().slice(0, 500);
      return t.includes('sign in') || t.includes('join linkedin') ||
             b.includes('please sign in') || b.includes('welcome back');
    }).catch(() => false);

    if (signedOutByUrl || signedOutByContent) {
      log(`  [preflight:${profileName}] LinkedIn redirected to sign-in — session expired on this GoLogin profile.`);
      return {
        ok: false,
        failureType: 'session_expired',
        detail: 'LinkedIn redirected this account to the sign-in page. Open the profile in GoLogin and log back in.',
      };
    }

    const looksMissing = await page.evaluate(() => {
      const t = (document.title || '').toLowerCase();
      const h1 = (document.querySelector('h1')?.innerText || '').toLowerCase();
      return t.includes('page not found') || t.includes("doesn't exist") ||
             h1.includes('page not found') || h1.includes('not available');
    }).catch(() => false);
    if (looksMissing) {
      return {
        ok: false,
        failureType: 'url_invalid',
        detail: `URL returned a not-found page: ${primaryUrl}`,
      };
    }

    log(`  [preflight:${profileName}] Profile page H1 didn't render within 10s — possible slow machine, network issue, or LinkedIn rate-limiting.`);
    return {
      ok: false,
      failureType: 'render_timeout',
      detail: 'Profile page loaded but the name didn\'t render within 10 seconds. Try again, or check if LinkedIn is rate-limiting this account.',
    };
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Catch "Page not found" / "This profile is not available"
  const pageMissing = await page.evaluate(() => {
    const t = (document.title || '').toLowerCase();
    const h1 = (document.querySelector('h1')?.innerText || '').toLowerCase();
    return t.includes('page not found') || t.includes("doesn't exist") ||
           h1.includes('page not found') || h1.includes('not available');
  });
  if (pageMissing) {
    return { ok: false, failureType: 'url_invalid', detail: `URL returned a not-found page: ${primaryUrl}` };
  }

  // ── Step 2: Extract canonical name from profile H1 ───────────────────────
  // Captured BEFORE the Message-button check so that not_connected failures
  // still carry the canonical name (helpful in debugging).
  const canonicalName = await page.evaluate(() => {
    const h1 = document.querySelector('h1.text-heading-xlarge, main h1, h1');
    return (h1?.innerText || '').trim().split('\n')[0].trim();
  });
  if (!canonicalName) {
    // Should be unreachable — waitForFunction above proved the H1 had content.
    // Keep as defensive guard in case the DOM mutates between the wait and the read.
    log(`  [preflight:${profileName}] Profile H1 rendered but canonical name extracted as empty — DOM may have shifted between wait and read.`);
    return { ok: false, failureType: 'render_timeout', detail: 'Profile H1 was present briefly but went empty before we could read it.' };
  }
  log(`  [preflight:${profileName}] Canonical name: "${canonicalName}"`);

  // ── Step 3: Check "Message" button presence (1st-degree proof) ───────────
  const hasMessageButton = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      'button, a, .pvs-profile-actions button, .pv-top-card button'
    ));
    return candidates.some(el => {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.innerText || '').toLowerCase().trim();
      return label.startsWith('message ') || label === 'message' ||
             text === 'message' || text.startsWith('message ');
    });
  });
  if (!hasMessageButton) {
    return {
      ok: false, failureType: 'not_connected', canonicalName,
      detail: 'No Message button on profile — not a 1st-degree connection',
    };
  }

  // ── Step 4: Typeahead test ───────────────────────────────────────────────
  // Navigate to a generic compose page. Use the sender's own messaging inbox
  // as a safe landing — opens the typeahead-capable recipient input without
  // needing a specific publicId.
  try {
    await page.goto('https://www.linkedin.com/messaging/?compose=true', {
      waitUntil: 'domcontentloaded', timeout: PROFILE_NAV_TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, failureType: 'crash', canonicalName, detail: `Compose nav failed: ${e.message}` };
  }
  await new Promise(r => setTimeout(r, 1200));

  // Find + tag the recipient input (same selector logic as sendIntroMessage).
  const tagged = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"][role="textbox"]'))
      .filter(isVisible);
    for (const el of inputs) {
      const text = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('class'),
        el.getAttribute('id'),
      ].join(' ').toLowerCase();
      if (text.includes('enter message recipients') || text.includes('msg-connections-typeahead__search-field')) {
        el.setAttribute('data-ortus-preflight', '1');
        return true;
      }
    }
    return false;
  });
  if (!tagged) {
    return { ok: false, failureType: 'crash', canonicalName, detail: 'Compose typeahead input not found' };
  }

  const sel = '[data-ortus-preflight="1"]';
  try {
    await page.click(sel);
    await page.type(sel, primaryName, { delay: 60 });
  } catch (e) {
    await page.evaluate(() => document.querySelector('[data-ortus-preflight="1"]')?.removeAttribute('data-ortus-preflight'));
    return { ok: false, failureType: 'crash', canonicalName, detail: `Type failed: ${e.message}` };
  }

  // Poll dropdown, gather candidate texts, run matcher in Node-side after each poll.
  let lastCandidates = [];
  for (let iter = 0; iter < TYPEAHEAD_POLL_ITER; iter++) {
    await new Promise(r => setTimeout(r, TYPEAHEAD_POLL_INTERVAL_MS));
    const cands = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const roots = Array.from(document.querySelectorAll(
        '.msg-connections-typeahead__search-results, [role="listbox"], .reusable-search__entity-result-list'
      ));
      const searchRoots = roots.length ? roots : [document];
      const out = [];
      for (const root of searchRoots) {
        const rows = Array.from(root.querySelectorAll(
          'li, [role="option"], button, .msg-connections-typeahead__search-result, .reusable-search__result-container'
        )).filter(isVisible);
        for (const r of rows) {
          const text = (r.innerText || r.textContent || '').trim().split('\n').slice(0, 2).join(' · ');
          if (text) out.push({ text });
        }
      }
      return out;
    });
    if (cands.length) lastCandidates = cands;
    const result = matchPrimaryCandidate(cands, primaryName);
    if (result.matchIndex !== null) {
      // Match found — pre-flight passes. We do NOT click; just clean up.
      await page.evaluate(() => document.querySelector('[data-ortus-preflight="1"]')?.removeAttribute('data-ortus-preflight'));
      const candidates = lastCandidates.slice(0, 3);
      log(`  [preflight:${profileName}] Typeahead matched: "${primaryName}" (reason=${result.reason})`);
      return { ok: true, canonicalName, candidates };
    }
  }

  // Out of polls — no match.
  await page.evaluate(() => document.querySelector('[data-ortus-preflight="1"]')?.removeAttribute('data-ortus-preflight'));
  return {
    ok: false, failureType: 'name_mismatch', canonicalName,
    candidates: lastCandidates.slice(0, 3),
    detail: lastCandidates.length === 0
      ? 'Dropdown never opened — typeahead may be broken or connection lost'
      : `${lastCandidates.length} suggestions but no match`,
  };
}
