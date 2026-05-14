/**
 * Pre-flight verifier — checks the configured primary person can be reached
 * from a given sender account before any CC+IC connection requests go out.
 *
 * Returns one of:
 *   { ok: true,  canonicalName, candidates }
 *   { ok: false, failureType: 'url_invalid' | 'not_connected' | 'name_mismatch' | 'crash' | 'config' | 'session_expired',
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
  // ── Detect sign-in redirect or genuine "page not found" first ─────────────
  // These are hard-stop failures regardless of whether the H1 renders. We
  // give the page 3 seconds to settle, then check.
  await new Promise(r => setTimeout(r, 3000));
  const currentUrl = page.url();
  const signedOutByUrl = /\/login|\/authwall|\/checkpoint|\/uas\/login/i.test(currentUrl);
  if (signedOutByUrl) {
    log(`  [preflight:${profileName}] LinkedIn redirected to sign-in — session expired.`);
    return {
      ok: false,
      failureType: 'session_expired',
      detail: 'LinkedIn redirected this account to the sign-in page. Open the profile in GoLogin and log back in.',
    };
  }
  const earlyChecks = await page.evaluate(() => {
    const t = (document.title || '').toLowerCase();
    const b = (document.body?.innerText || '').toLowerCase().slice(0, 500);
    const signedOutByContent = t.includes('sign in') || t.includes('join linkedin') ||
                               b.includes('please sign in') || b.includes('welcome back');
    const looksMissing = t.includes('page not found') || t.includes("doesn't exist") ||
                         t.includes('this page doesn') ||
                         b.includes('this page isn\'t available');
    return { signedOutByContent, looksMissing };
  }).catch(() => ({ signedOutByContent: false, looksMissing: false }));
  if (earlyChecks.signedOutByContent) {
    return {
      ok: false,
      failureType: 'session_expired',
      detail: 'LinkedIn redirected this account to the sign-in page. Open the profile in GoLogin and log back in.',
    };
  }
  if (earlyChecks.looksMissing) {
    return {
      ok: false,
      failureType: 'url_invalid',
      detail: `URL returned a not-found page: ${primaryUrl}`,
    };
  }

  // ── Step 2 (best-effort): try to read the canonical name from the H1 ─────
  // Used only for the "did you mean…" UX. If we can't read it, that's fine —
  // we just won't offer did-you-mean for this profile.
  let canonicalName = '';
  try {
    await page.waitForFunction(() => {
      const candidates = Array.from(document.querySelectorAll(
        'h1.text-heading-xlarge, main h1, h1, [data-anonymize="person-name"]'
      ));
      return candidates.some(h => (h.innerText || h.textContent || '').trim().length > 2);
    }, { timeout: 5_000 });
    canonicalName = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(
        'h1.text-heading-xlarge, main h1, h1, [data-anonymize="person-name"]'
      ));
      for (const h of candidates) {
        const text = (h.innerText || h.textContent || '').trim().split('\n')[0].trim();
        if (text.length > 2) return text;
      }
      return '';
    });
  } catch {
    log(`  [preflight:${profileName}] Couldn't read profile H1 within 5s — continuing without canonical name. Did-you-mean UX will not be available for this profile.`);
  }
  if (canonicalName) {
    log(`  [preflight:${profileName}] Canonical name: "${canonicalName}"`);
  }

  // ── Step 3: Check 1st-degree connection status ────────────────────────────
  // The "· 1st" badge next to the name is the authoritative signal. We also
  // accept the Message button as a fallback for DOM variants that hide the
  // badge. NOTE: this isn't a hard-fail — the typeahead test (Step 4) is
  // authoritative. We log the result for diagnostics.
  const connectionInfo = await page.evaluate(() => {
    // Look for "· 1st" badge — usually a span with class containing "dist" or
    // inline text "1st" near the H1. Tolerate "·" middot prefix.
    const allSpans = Array.from(document.querySelectorAll(
      '.dist-value, .distance-badge, [class*="distance"], main span, header span, h1 + span'
    ));
    let badge1st = false;
    let badgeOther = '';
    for (const el of allSpans) {
      const text = (el.innerText || el.textContent || '').replace(/[·\s]+/g, ' ').trim().toLowerCase();
      if (text === '1st' || /^1st(?:\s|$)/.test(text)) { badge1st = true; break; }
      if (/^2nd(?:\s|$)/.test(text) || /^3rd\+?(?:\s|$)/.test(text)) {
        badgeOther = text; // capture for diagnostics
      }
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('1st degree')) { badge1st = true; break; }
    }
    // Message button as fallback signal
    const buttons = Array.from(document.querySelectorAll(
      'button, a, .pvs-profile-actions button, .pv-top-card button'
    ));
    const hasMessageButton = buttons.some(el => {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.innerText || '').toLowerCase().trim();
      return label.startsWith('message ') || label === 'message' ||
             text === 'message' || text.startsWith('message ');
    });
    return { badge1st, badgeOther, hasMessageButton };
  }).catch(() => ({ badge1st: false, badgeOther: '', hasMessageButton: false }));

  if (connectionInfo.badge1st) {
    log(`  [preflight:${profileName}] ✓ 1st-degree badge detected on profile.`);
  } else if (connectionInfo.hasMessageButton) {
    log(`  [preflight:${profileName}] Message button present but no "1st" badge — proceeding with typeahead test as the authoritative check.`);
  } else if (connectionInfo.badgeOther) {
    log(`  [preflight:${profileName}] Found "${connectionInfo.badgeOther}" badge — this person is NOT a 1st-degree connection on this account.`);
    return {
      ok: false,
      failureType: 'not_connected',
      canonicalName,
      detail: `LinkedIn shows this person as a ${connectionInfo.badgeOther} connection on this account, not 1st-degree. Intros will fail.`,
    };
  } else {
    log(`  [preflight:${profileName}] No 1st-degree badge or Message button found on the profile page — continuing with typeahead test (which is authoritative).`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Step 4: Typeahead test ───────────────────────────────────────────────
  // Navigate to the generic compose page. The page is a heavy SPA — we need
  // to POLL for the recipient input to mount rather than waiting a fixed
  // time. Slow machines need 5-10 seconds.
  try {
    await page.goto('https://www.linkedin.com/messaging/?compose=true', {
      waitUntil: 'domcontentloaded', timeout: PROFILE_NAV_TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, failureType: 'crash', canonicalName, detail: `Compose nav failed: ${e.message}` };
  }

  // Poll up to 15 seconds for the recipient input to appear and be tag-able.
  // Done in browser context so we can match across class-name variants —
  // LinkedIn renames classes regularly; the aria-label / placeholder is the
  // most stable signal.
  log(`  [preflight:${profileName}] Waiting for compose page recipient input to render…`);
  let tagged = false;
  try {
    await page.waitForFunction(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const inputs = Array.from(document.querySelectorAll(
        'input, textarea, [contenteditable="true"][role="textbox"]'
      )).filter(isVisible);
      for (const el of inputs) {
        const text = [
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.getAttribute('class'),
          el.getAttribute('id'),
        ].join(' ').toLowerCase();
        if (text.includes('enter message recipients') ||
            text.includes('msg-connections-typeahead__search-field') ||
            text.includes('type a name') ||
            text.includes('type the name')) {
          el.setAttribute('data-ortus-preflight', '1');
          return true;
        }
      }
      return false;
    }, { timeout: 15_000, polling: 500 });
    tagged = true;
  } catch {
    // Input never appeared. Detect WHY:
    // - Sign-in redirect (session expired between Stage A and Stage B)
    // - LinkedIn changed the compose page layout entirely
    const url = page.url();
    const signedOut = /\/login|\/authwall|\/checkpoint|\/uas\/login/i.test(url);
    if (signedOut) {
      return {
        ok: false,
        failureType: 'session_expired',
        canonicalName,
        detail: 'LinkedIn redirected to sign-in when opening the compose page. This GoLogin profile needs to log back in.',
      };
    }
    return {
      ok: false,
      failureType: 'crash',
      canonicalName,
      detail: 'Compose page loaded but the recipient input never appeared within 15s. LinkedIn may have changed the layout, or the page didn\'t finish loading on this machine.',
    };
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
