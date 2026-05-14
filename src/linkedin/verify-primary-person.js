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

const PROFILE_NAV_TIMEOUT_MS = 30_000;

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

  // ── Step 4: URL-recipient routing test ───────────────────────────────────
  // Mirrors the URL pattern that src/linkedin/actions.js sendIntroMessage uses
  // in real campaigns. Navigate to /messaging/compose/?recipient=<publicId>
  // and verify LinkedIn accepts the recipient (renders a "Remove" pill).
  // This is more reliable than typing into the typeahead — same internal
  // LinkedIn routing path that the actual campaign uses.
  const publicIdMatch = primaryUrl.match(/\/in\/([^/?#]+)/);
  if (!publicIdMatch) {
    return {
      ok: false,
      failureType: 'url_invalid',
      canonicalName,
      detail: `Could not extract publicId from primaryUrl: ${primaryUrl}`,
    };
  }
  const primaryPublicId = publicIdMatch[1];
  const composeUrl = `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(primaryPublicId)}`;

  log(`  [preflight:${profileName}] Opening compose with recipient=${primaryPublicId}…`);
  try {
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: PROFILE_NAV_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, failureType: 'crash', canonicalName, detail: `Compose nav failed: ${e.message}` };
  }

  // Wait up to 15s for the recipient "Remove" pill to appear, confirming
  // LinkedIn routed the publicId to a real connection.
  log(`  [preflight:${profileName}] Waiting for recipient pill to appear (up to 15s)…`);
  let pillFound = false;
  let pillAriaLabel = '';
  try {
    pillAriaLabel = await page.waitForFunction(() => {
      const pills = Array.from(document.querySelectorAll(
        '.msg-connections-typeahead__added-recipients button[aria-label^="Remove"], button.artdeco-pill[aria-label^="Remove"]'
      ));
      if (pills.length === 0) return false;
      // Return the first pill's aria-label so we can log it.
      return pills[0].getAttribute('aria-label') || 'Remove (no label)';
    }, { timeout: 15_000, polling: 500 }).then(handle => handle.jsonValue());
    pillFound = true;
  } catch {
    // Recipient pill never appeared. Distinguish causes.
    const currentUrl = page.url();
    const signedOut = /\/login|\/authwall|\/checkpoint|\/uas\/login/i.test(currentUrl);
    if (signedOut) {
      return {
        ok: false,
        failureType: 'session_expired',
        canonicalName,
        detail: 'LinkedIn redirected to sign-in when opening the compose page. This GoLogin profile needs to log back in.',
      };
    }
    // No pill + not signed out. Most likely: primary is not actually messageable
    // from this account (not a 1st-degree connection OR LinkedIn blocked the
    // routing for some other reason).
    return {
      ok: false,
      failureType: 'not_connected',
      canonicalName,
      detail: `LinkedIn did not add the primary person as a recipient. This usually means the primary isn't a 1st-degree connection on this account, or LinkedIn doesn't recognize the publicId "${primaryPublicId}".`,
    };
  }

  log(`  [preflight:${profileName}] ✓ Recipient pill detected (aria-label: "${pillAriaLabel}")`);
  return { ok: true, canonicalName, candidates: [] };
  // ─────────────────────────────────────────────────────────────────────────
}
