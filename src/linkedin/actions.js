/**
 * LinkedIn actions — v18.
 *
 * CORE PRINCIPLE: Every click uses element.click() via page.evaluate().
 * NEVER page.mouse.click(x, y).
 *
 * This means:
 * - No coordinate calculations
 * - No viewport size dependencies
 * - No zoom dependencies
 * - Works whether element is visible, off-screen, or in Shadow DOM
 *
 * Shadow DOM buttons are reached via:
 *   document.getElementById('interop-outlet').shadowRoot.querySelector(...)
 */

import { randomDelay, clickByAria, clickByText } from './helpers.js';

// Matches Sales Navigator profile URLs (/sales/people/… or /sales/lead/…).
// Kept in sync with the identical constant in outreach.js — duplication here
// is deliberate (avoids cross-coupling the two files for a 1-line regex).
const SALES_NAV_URL_RE = /\/sales\/(people|lead)\//;

// ─────────────────────────────────────────────────────────────────────────────
// Detect modal — checks both regular DOM and Shadow DOM
// ─────────────────────────────────────────────────────────────────────────────

async function detectModal(page) {
  return page.evaluate(() => {
    // Collect buttons from regular DOM + ALL Shadow DOM roots
    const buttons = Array.from(document.querySelectorAll('button'));
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) buttons.push(...Array.from(el.shadowRoot.querySelectorAll('button')));
    });

    const findByAria = (label) => buttons.find(b =>
      (b.getAttribute('aria-label') || '').toLowerCase() === label.toLowerCase()
    );
    const findByText = (text) => buttons.find(b =>
      b.textContent?.trim().toLowerCase() === text.toLowerCase()
    );

    const sendWithout = findByAria('Send without a note') || findByText('Send without a note');
    const addNote = findByAria('Add a note') || findByText('Add a note');
    const send = findByAria('Send') || findByText('Send') || findByText('send invitation');
    const withdraw = findByText('withdraw');

    // Gather all visible text (regular + all shadow DOMs)
    let pageText = (document.body?.innerText || '').substring(0, 5000).toLowerCase();
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) pageText += (el.shadowRoot.textContent || '').substring(0, 3000).toLowerCase();
    });

    const hasHowDoYouKnow = pageText.includes('how do you know');

    // Weekly/invitation limit detection — matches both modal text and inline banner text
    // Banner says: "weekly limit for connection invitations"
    // Modal says: "weekly invitation limit"
    const hasWeeklyLimit = pageText.includes('weekly invitation limit') ||
                           pageText.includes('weekly limit for connection') ||
                           pageText.includes('invitation was not sent') ||
                           pageText.includes("you've reached") ||
                           pageText.includes('reached the weekly limit') ||
                           pageText.includes('invitation limit') ||
                           pageText.includes('too many pending') ||
                           pageText.includes('try again next week');

    // Email required to connect
    const hasEmailRequired = pageText.includes('enter their email') ||
                             pageText.includes('verify this member knows you') ||
                             pageText.includes('email address to connect');

    const found = !!(sendWithout || addNote || send || withdraw || hasHowDoYouKnow || hasWeeklyLimit || hasEmailRequired);

    return {
      found,
      hasAddNote: !!addNote,
      hasSendWithout: !!sendWithout,
      hasSend: !!send,
      hasWithdraw: !!withdraw,
      hasHowDoYouKnow,
      hasWeeklyLimit,
      hasEmailRequired,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if Pending
// ─────────────────────────────────────────────────────────────────────────────

async function isPending(page) {
  // Step 1: Check for Pending as a visible button in the profile's action bar
  // ONLY check buttons and actionable elements — NOT divs/spans (too many false positives)
  const directPending = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const profileName = h1 ? h1.textContent.trim().split('\n')[0].trim().toLowerCase() : '';
    const firstName = profileName.split(/\s+/)[0] || '';

    // Find the "More" button to locate the action bar
    const moreBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      return a === 'more actions' || a === 'more' || t === 'more';
    });

    // Scope: only check buttons in the action bar area (same parent as More button)
    const actionBar = moreBtn ? (moreBtn.closest('div, section, ul') || moreBtn.parentElement) : null;
    const searchAreas = actionBar ? [actionBar] : [];
    // Also check the h1's parent section
    if (h1) {
      const h1Section = h1.closest('main, section, [class*="top-card"]');
      if (h1Section && !searchAreas.includes(h1Section)) searchAreas.push(h1Section);
    }

    for (const area of searchAreas) {
      const buttons = Array.from(area.querySelectorAll('button, a, [role="button"]'));
      for (const b of buttons) {
        const t = (b.textContent || '').trim().toLowerCase();
        const a = (b.getAttribute('aria-label') || '').toLowerCase();

        if (a.includes('pending')) {
          if (firstName && !a.includes(firstName)) continue;
          return 'aria-scoped';
        }
        if (t === 'pending' && b.offsetWidth > 0) {
          return 'text-scoped';
        }
      }
    }
    return null;
  });

  if (directPending) return true;

  // Step 2: Open the "More" dropdown and check for "Pending" inside it
  const morePending = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const more = buttons.find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      return a === 'more actions' || a === 'more' || t === 'more';
    });
    if (more) { more.click(); return true; }
    return false;
  });

  if (!morePending) return false;

  await new Promise(r => setTimeout(r, 2000));

  const pendingInDropdown = await page.evaluate(() => {
    // Only check dropdown-specific elements
    const items = Array.from(document.querySelectorAll('li, [role="menuitem"], .artdeco-dropdown__item'));
    for (const el of items) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'pending') return true;
      const a = (el.getAttribute('aria-label') || '').toLowerCase();
      if (a.includes('pending')) return true;
    }
    return false;
  });

  // Close the dropdown
  await page.evaluate(() => document.body.click());
  await new Promise(r => setTimeout(r, 500));

  return pendingInDropdown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Voyager invitation-creation network listener (v2.10.0 — Approach A)
//
// Registers a page.on('response') hook that captures LinkedIn's own backend
// response to the invitation POST. This is the gold-standard signal — it
// bypasses toast races, profile-reload latency, and DOM selector drift.
//
// URL pattern matches both with-note and without-note sends; the decoration
// `InvitationCreationResult` is shared across all variants.
//
// On 2xx → ok=true with invitationUrn extracted from data.value.invitationUrn.
// On 4xx → ok=false with status + body parsed for finer-grained skip reason.
// ─────────────────────────────────────────────────────────────────────────────

const VOYAGER_INVITATION_RE = /voyagerRelationshipsDashMemberRelationships.*InvitationCreationResult/i;

function attachVoyagerInvitationCapture(page) {
  const captured = { fired: false, ok: null, status: null, urn: null, errorMessage: null };
  const waiters = [];

  const listener = async (response) => {
    try {
      if (!VOYAGER_INVITATION_RE.test(response.url())) return;
      const status = response.status();
      let body = null;
      try { body = await response.json(); } catch { /* may not be JSON */ }

      const ok = status >= 200 && status < 300;
      const urn = body?.data?.value?.invitationUrn || body?.data?.invitationUrn || null;
      const errorMessage = ok
        ? null
        : (body?.message || body?.errorDetails?.message || body?.errorMessage || `HTTP ${status}`);

      captured.fired = true;
      captured.ok = ok;
      captured.status = status;
      captured.urn = urn;
      captured.errorMessage = errorMessage;

      const result = { ok, status, urn, errorMessage };
      const ws = waiters.splice(0);
      for (const w of ws) w(result);
    } catch (e) {
      console.warn(`[voyager-capture] listener error: ${e.message}`);
    }
  };

  page.on('response', listener);

  return {
    waitFor(timeoutMs) {
      if (captured.fired) {
        return Promise.resolve({
          ok: captured.ok,
          status: captured.status,
          urn: captured.urn,
          errorMessage: captured.errorMessage,
        });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(onFire);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        const onFire = (result) => { clearTimeout(timer); resolve(result); };
        waiters.push(onFire);
      });
    },
    fired() { return captured.fired; },
    detach() {
      try { page.off('response', listener); } catch { /* page may be closed */ }
      const ws = waiters.splice(0);
      for (const w of ws) w(null);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Type into message/note field
// ─────────────────────────────────────────────────────────────────────────────

async function typeIntoField(page, text) {
  // Order matters: most-specific message/note selectors first. Otherwise the
  // generic `div[contenteditable="true"]` can match LinkedIn's top-nav search
  // bar (also contenteditable) and silently type into it.
  // For message composers specifically, if multiple are present we take the
  // LAST one (most recently mounted) — LinkedIn appends new bubbles to the
  // end of `.msg-overlay-list-bubble`, and the most recent is the current lead.
  const SELECTORS = [
    // Connect-note modal
    'textarea[name="message"]', 'textarea#custom-message',
    // Message composer (Quill editor) — scoped to the form container
    '.msg-form__contenteditable',
    '.msg-form__msg-content-container div[contenteditable="true"]',
    '.msg-form div[contenteditable="true"]',
    'div[aria-label*="Write a message"]',
    'div[aria-label*="Add a note"]',
    // InMail / other dialogs
    'div[role="dialog"] textarea',
    'div[role="dialog"] div[contenteditable="true"]',
    // Generic textarea fallback
    'textarea',
  ];
  // Selectors for which we should pick the LAST match (most recently mounted).
  const PICK_LAST_SELECTORS = new Set([
    '.msg-form__contenteditable',
    '.msg-form__msg-content-container div[contenteditable="true"]',
    '.msg-form div[contenteditable="true"]',
    'div[aria-label*="Write a message"]',
  ]);

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Inject value directly using React's native setter so the synthetic
    // onChange fires and LinkedIn's controlled component accepts it.
    const injected = await page.evaluate((selectors, pickLastSelectors, value) => {
      const pickLast = new Set(pickLastSelectors);
      const findField = (root) => {
        for (const sel of selectors) {
          if (pickLast.has(sel)) {
            const all = root.querySelectorAll(sel);
            if (all.length) return all[all.length - 1];
          } else {
            const el = root.querySelector(sel);
            if (el) return el;
          }
        }
        return null;
      };

      let el = findField(document);
      if (!el) {
        const hosts = Array.from(document.querySelectorAll('*')).filter(x => x.shadowRoot);
        for (const host of hosts) {
          el = findField(host.shadowRoot);
          if (el) break;
        }
      }
      if (!el) return { ok: false, reason: 'field-not-found' };

      el.focus();

      const isTextarea = el.tagName === 'TEXTAREA';
      const isInput = el.tagName === 'INPUT';

      if (isTextarea || isInput) {
        const proto = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        nativeSetter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // contenteditable path — LinkedIn's message composer is a Quill
        // editor. Quill maintains its own document model and listens for
        // `paste` events via its Clipboard module, so dispatching a real
        // ClipboardEvent with a DataTransfer is the most reliable way to
        // populate it.
        // 2.8.34: trust the paste; the outer post-400ms verification
        // re-tries on mismatch. The previous synchronous lengthRatio check
        // raced Quill's async render and forced an execCommand fallback that
        // overwrote the in-flight paste, leaving a malformed editor.
        el.focus();
        // Select + delete any existing content
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false);
        } catch { /* */ }

        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', value);
          const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(pasteEvent);
        } catch { /* */ }

        // 2.8.45: dispatch InputEvent so React's onChange fires. Without this,
        // LinkedIn's React state thinks the composer is empty and keeps the
        // Send button disabled even though the text is visible. Mirrors what
        // the LinkedIn DM Assistant extension does after paste.
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            inputType: 'insertText',
            data: value,
          }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch { /* */ }
      }

      const got = isTextarea || isInput ? el.value : (el.textContent || el.innerText || '');
      return { ok: true, got };
    }, SELECTORS, [...PICK_LAST_SELECTORS], text);

    if (!injected.ok) {
      console.warn(`[actions] Field not found on attempt ${attempt}: ${injected.reason}`);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    await new Promise(r => setTimeout(r, 400));

    // Read back authoritative content after React re-render
    const fieldContent = await page.evaluate((selectors, pickLastSelectors) => {
      const pickLast = new Set(pickLastSelectors);
      const findField = (root) => {
        for (const sel of selectors) {
          if (pickLast.has(sel)) {
            const all = root.querySelectorAll(sel);
            if (all.length) return all[all.length - 1];
          } else {
            const el = root.querySelector(sel);
            if (el) return el;
          }
        }
        return null;
      };
      let el = findField(document);
      if (!el) {
        const hosts = Array.from(document.querySelectorAll('*')).filter(x => x.shadowRoot);
        for (const host of hosts) {
          el = findField(host.shadowRoot);
          if (el) break;
        }
      }
      if (!el) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
      // 2.8.35: prefer innerText over textContent for contenteditable. Quill
      // renders multi-line as <p>line</p><p>line</p>; textContent strips the
      // tags AND the implicit newlines between blocks ("line1line2"), but
      // innerText respects block layout and emits "line1\nline2". Without
      // this the verification below fails on every multi-line template,
      // returning false and leaving the message un-sent in the composer.
      return el.innerText || el.textContent || '';
    }, SELECTORS, [...PICK_LAST_SELECTORS]);

    // Verification: strict equality for textareas (connect-note modal),
    // whitespace-normalized match for contenteditable (Quill message composer,
    // which wraps content in <p> tags and collapses newlines in textContent).
    const expected = text.replace(/\r\n/g, '\n');
    const got = fieldContent.replace(/\r\n/g, '\n');
    const normalize = s => s.replace(/\s+/g, ' ').trim();
    // 2.8.35: third compare — strip ALL whitespace. Belt-and-suspenders for
    // edge cases where Quill emits a different whitespace pattern than the
    // template (e.g. drops a blank line between paragraphs).
    const stripWs = s => s.replace(/\s+/g, '');

    if (
      got === expected ||
      normalize(got) === normalize(expected) ||
      stripWs(got) === stripWs(expected)
    ) {
      if (attempt > 1) console.log(`[actions] Note verified on attempt ${attempt}.`);
      return true;
    }

    console.warn(
      `[actions] Note mismatch (attempt ${attempt}/${MAX_ATTEMPTS}). ` +
      `Expected ${expected.length} chars, got ${got.length}. ` +
      `Expected head: "${expected.substring(0, 60)}…" Got head: "${got.substring(0, 60)}…"`
    );

    // 2.8.34: keyboard.type fallback removed. Prior runs showed the typing
    // path producing visible mistakes (Quill mid-render fights with synthetic
    // keystrokes). Paste-only is safer: if all paste attempts fail, return
    // false and let the caller surface the error rather than typing.
  }

  console.error('[actions] Failed to type note correctly after all attempts. Will NOT send.');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Click Connect from More dropdown — ALL via JS click
// ─────────────────────────────────────────────────────────────────────────────

async function clickConnectFromMore(page) {
  console.log('[actions] Opening More dropdown…');

  // Step 1: Click the More button via JS
  const moreClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const more = buttons.find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      return a === 'more actions' || a === 'more' || t === 'more';
    });
    if (more) { more.click(); return true; }
    return false;
  });

  if (!moreClicked) {
    console.log('[actions] More button not found.');
    return false;
  }

  // Step 2: Wait 5 seconds for dropdown to fully render
  console.log('[actions] More clicked. Waiting 5s for dropdown…');
  await new Promise(r => setTimeout(r, 5000));

  // Step 3: Find and click "Connect" in dropdown via JS
  const connectClicked = await page.evaluate(() => {
    // Search dropdown items — look for exact "Connect" text
    const selectors = 'li, [role="menuitem"], [role="option"], .artdeco-dropdown__item';
    const items = Array.from(document.querySelectorAll(selectors));

    for (const el of items) {
      const text = (el.textContent || '').trim();
      if (text === 'Connect') {
        el.click();
        return 'dom';
      }
    }

    // Try spans inside the actual dropdown container only
    const dropdowns = document.querySelectorAll('.artdeco-dropdown__content, [role="menu"], .artdeco-dropdown__content--is-open');
    for (const dropdown of dropdowns) {
      if (!dropdown.offsetWidth) continue; // skip hidden dropdowns
      const spans = dropdown.querySelectorAll('span, div, a');
      for (const el of spans) {
        const text = (el.textContent || '').trim();
        if (text === 'Connect' && el.offsetWidth > 0) {
          const parent = el.closest('li') || el.closest('[role="menuitem"]') || el;
          parent.click();
          return 'dropdown-connect';
        }
      }
    }

    // Shadow DOM dropdown
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.shadowRoot) {
      const shadowItems = Array.from(outlet.shadowRoot.querySelectorAll(selectors));
      for (const el of shadowItems) {
        const text = (el.textContent || '').trim();
        if (text === 'Connect') {
          el.click();
          return 'shadow';
        }
      }
    }

    return null;
  });

  if (connectClicked) {
    console.log(`[actions] ✓ Connect clicked from dropdown (${connectClicked}).`);
    return true;
  }

  // Debug: log what IS in the dropdown
  const dropdownItems = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li, [role="menuitem"]'))
      .map(el => el.textContent?.trim())
      .filter(t => t && t.length < 50)
      .slice(0, 10);
  });
  console.log('[actions] Dropdown items found:', JSON.stringify(dropdownItems));

  // Close dropdown
  await page.evaluate(() => document.body.click());
  console.log('[actions] Connect not in dropdown.');
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// sendConnectionRequest
// ═════════════════════════════════════════════════════════════════════════════

export async function sendConnectionRequest(page, noteArg) {
  let note = noteArg;
  // v2.10.0 (Approach A): register the Voyager invitation-create listener before
  // any user interaction. Captures LinkedIn's own backend response, which is the
  // definitive signal that an invitation actually landed (or was rejected).
  const voyagerCapture = attachVoyagerInvitationCapture(page);
  try {
  // Scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await randomDelay(300, 500);

  let connectClicked = false;

  // Retry loop: keep looking for Connect button for up to 30 seconds
  // Accounts for slow page loads and lazy-rendered elements
  const MAX_WAIT_MS = 30000;
  const POLL_INTERVAL_MS = 3000;
  const startTime = Date.now();

  while (!connectClicked && (Date.now() - startTime) < MAX_WAIT_MS) {
    const directClicked = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const profileName = h1 ? h1.textContent.trim().split('\n')[0].trim().toLowerCase() : '';
      const firstName = profileName.split(/\s+/)[0] || '';

      // METHOD 1: aria-label "Invite [name] to connect" — name MUST match
      if (firstName) {
        const allInvites = document.querySelectorAll('[aria-label*="Invite"][aria-label*="to connect"]');
        for (const el of allInvites) {
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes(firstName)) {
            el.click();
            return 'aria-invite-matched';
          }
        }
      }

      // METHOD 2: <a href="...custom-invite..."> link — unique to profile owner
      const allLinks = Array.from(document.querySelectorAll('a'));
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) allLinks.push(...Array.from(el.shadowRoot.querySelectorAll('a')));
      });
      for (const el of allLinks) {
        const href = (el.getAttribute('href') || '');
        if (href.includes('custom-invite')) {
          el.click();
          return 'custom-invite-link';
        }
      }

      // NO OTHER FALLBACKS — if neither matched, go to More dropdown
      return null;
    });

    if (directClicked) {
      console.log(`[actions] ✓ Direct Connect button clicked (${directClicked}).`);
      connectClicked = true;
      console.log('[actions] Waiting 5s for modal…');
      await new Promise(r => setTimeout(r, 5000));
      break;
    }

    // PRIORITY 2: Only try More dropdown if direct button wasn't found
    console.log(`[actions] No direct Connect — trying More dropdown… (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
    connectClicked = await clickConnectFromMore(page);
    if (connectClicked) {
      console.log('[actions] Waiting 5s for modal…');
      await new Promise(r => setTimeout(r, 5000));
      break;
    }

    // Neither found — wait and retry
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[actions] Connect not found yet (${elapsed}s / 60s). Retrying in 5s…`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!connectClicked) {
    // 2.9.8: capture a diagnostic snapshot of what was actually visible on
    // the page when the finder timed out. Full snapshot goes to stdout
    // (campaign.log via npm pipe). The thrown Error gets a short summary
    // appended so the campaign log line itself shows the most useful
    // breadcrumbs (URL host, errorpg flag, button names).
    let summary = '';
    try {
      const snapshot = await page.evaluate(() => {
        const main = document.querySelector('main');
        const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'))
          .filter(b => b.offsetWidth > 0)
          .slice(0, 20)
          .map(b => ({
            t: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
            a: (b.getAttribute('aria-label') || '').slice(0, 50),
          }));
        return {
          url: window.location.href,
          mainCls: (main?.className || '').toString().slice(0, 80),
          hasEmailField: !!document.querySelector('input[type=email]'),
          hasErrorPg: /errorpg|error-page/i.test(main?.className || ''),
          buttons,
        };
      });
      console.error('[actions] Connect-not-found DIAGNOSTIC: ' + JSON.stringify(snapshot));
      const btnNames = (snapshot.buttons || [])
        .map(b => b.t || b.a)
        .filter(Boolean)
        .slice(0, 6)
        .join(' | ');
      const tags = [];
      if (snapshot.hasErrorPg) tags.push('errorpg');
      if (snapshot.hasEmailField) tags.push('emailField');
      summary = ` [${tags.join(',') || 'no-tags'}; visible: ${btnNames || 'none'}]`;
    } catch (e) {
      console.error(`[actions] Connect-not-found DIAGNOSTIC failed: ${e.message}`);
    }
    throw new Error('Connect button not found after 60s' + summary);
  }

  // ── Wait for modal, success toast, or Pending (8 attempts = ~24s max) ──
  for (let attempt = 1; attempt <= 8; attempt++) {
    // Check for "Invitation sent to X" green toast — definitive proof
    const successToast = await page.evaluate(() => {
      const toasts = document.querySelectorAll('.artdeco-toast-item, [data-test-artdeco-toast-item-type="success"]');
      for (const t of toasts) {
        const text = (t.textContent || '').toLowerCase();
        if (text.includes('invitation sent')) return text.trim().substring(0, 100);
      }
      return null;
    });
    if (successToast) {
      console.log(`[actions] ✓ Success toast: "${successToast}"`);
      return { invitationUrn: null };
    }

    // IMPORTANT: Check modal FIRST — if a modal is open, we MUST handle it.
    // Do NOT check isPending before modal, because isPending can false-positive
    // from recommendation Pending buttons while the modal is still open.
    const modal = await detectModal(page);
    if (modal.found) {
      // Modal is open — handle it below (fall through to modal handling code)
    } else {
      // No modal — safe to check Pending
      if (await isPending(page)) {
        console.log('[actions] ✓ Connection sent (Pending detected).');
        return { invitationUrn: null };
      }
    }

    // Check for inline weekly limit banner (appears instead of modal)
    const inlineBanner = await page.evaluate(() => {
      const text = (document.body?.innerText || '').substring(0, 5000).toLowerCase();
      if (text.includes('invitation was not sent') ||
          text.includes('weekly limit for connection') ||
          text.includes('reached the weekly limit') ||
          text.includes('try again next week')) {
        return true;
      }
      let shadowText = '';
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) shadowText += (el.shadowRoot.textContent || '').substring(0, 2000).toLowerCase();
      });
      return shadowText.includes('invitation was not sent') ||
             shadowText.includes('weekly limit') ||
             shadowText.includes('try again next week');
    });
    if (inlineBanner) {
      console.log('[actions] ⚠ Inline weekly limit banner detected on page.');
      throw new Error('WEEKLY_LIMIT');
    }

    // modal was already detected above — reuse it
    if (modal.found) {
      console.log(`[actions] Modal (attempt ${attempt}):`, JSON.stringify({
        addNote: modal.hasAddNote, sendWithout: modal.hasSendWithout,
        send: modal.hasSend, withdraw: modal.hasWithdraw,
      }));

      // Withdraw → already pending
      if (modal.hasWithdraw) {
        await clickByText(page, 'cancel');
        console.log('[actions] Already pending (withdraw).');
        return { invitationUrn: null };
      }

      // Weekly/invitation limit → abort this profile
      if (modal.hasWeeklyLimit) {
        // Close the modal
        await clickByAria(page, 'Dismiss').catch(() => {});
        await clickByText(page, 'Got it').catch(() => {});
        throw new Error('WEEKLY_LIMIT');
      }

      // Email required to connect → skip this lead
      if (modal.hasEmailRequired) {
        // Close the modal
        await clickByAria(page, 'Dismiss').catch(() => {});
        await clickByText(page, 'Cancel').catch(() => {});
        throw new Error('EMAIL_REQUIRED');
      }

      // "How do you know"
      if (modal.hasHowDoYouKnow) {
        await clickByText(page, 'Other');
        await randomDelay(600, 1000);
        await clickByText(page, 'Connect');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // "Add a note" flow
      if (note && modal.hasAddNote) {
        console.log('[actions] Clicking "Add a note"…');
        await clickByAria(page, 'Add a note');
        await new Promise(r => setTimeout(r, 5000));
        const noteTyped = await typeIntoField(page, note);
        if (!noteTyped) {
          console.warn('[actions] Note typing failed after 3 attempts. Clearing field and sending without a note.');
          // Clear any half-typed content so it can't possibly leak
          await page.evaluate(() => {
            const sels = ['textarea[name="message"]', 'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]'];
            for (const sel of sels) {
              const el = document.querySelector(sel);
              if (el) {
                el.focus();
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                  el.innerHTML = '';
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                }
                return;
              }
            }
          });
          await new Promise(r => setTimeout(r, 300));

          // Dismiss the entire invite modal (Cancel button in the Add-a-note view
          // closes the whole flow on current LinkedIn)
          await clickByText(page, 'Cancel').catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
          await new Promise(r => setTimeout(r, 1500));

          // Re-click Connect from scratch — reuses the same direct-click logic
          // as the top of this function
          const reconnected = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            const profileName = h1 ? h1.textContent.trim().split('\n')[0].trim().toLowerCase() : '';
            const firstName = profileName.split(/\s+/)[0] || '';
            if (firstName) {
              const allInvites = document.querySelectorAll('[aria-label*="Invite"][aria-label*="to connect"]');
              for (const el of allInvites) {
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                if (aria.includes(firstName)) { el.click(); return 'aria'; }
              }
            }
            return null;
          });

          if (!reconnected) {
            // Fall back to More dropdown
            const moreOk = await clickConnectFromMore(page);
            if (!moreOk) {
              console.error('[actions] Could not re-open Connect after note failure. Aborting.');
              throw new Error('NOTE_TYPING_FAILED: could not re-open Connect to send without a note');
            }
          }

          await new Promise(r => setTimeout(r, 5000));

          // Now the fresh invite modal is showing; click "Send without a note"
          note = '';
          const sentR = await clickByAria(page, 'Send without a note');
          if (!sentR) {
            // Some modals label it just "Send"
            const sendR = await clickByAria(page, 'Send');
            if (!sendR) {
              const byText = await clickByText(page, 'Send without a note');
              if (!byText) {
                console.error('[actions] Fresh invite modal did not expose Send-without-note button.');
                throw new Error('NOTE_TYPING_FAILED: fresh invite modal missing Send-without-note');
              }
            }
          }
          console.log('[actions] ✓ Sent without a note (note typing fallback).');
          // ── Approach A: Voyager network response (gold-standard signal) ──
          await new Promise(r => setTimeout(r, 1500));
          const voyagerA = await voyagerCapture.waitFor(10000);
          if (voyagerA) {
            if (voyagerA.ok) {
              console.log(`[actions] ✓ Voyager confirmed (fallback): HTTP ${voyagerA.status}, urn=${voyagerA.urn || 'n/a'}`);
              return { invitationUrn: voyagerA.urn };
            }
            console.error(`[actions] ✗ Voyager rejected (fallback): HTTP ${voyagerA.status} — ${voyagerA.errorMessage || ''}`);
            throw new Error(`VOYAGER_REJECTED: HTTP ${voyagerA.status} — ${voyagerA.errorMessage || 'unknown reason'}`);
          }
          console.log('[actions] Voyager did not fire — falling back to DOM-based verification.');

          // Legacy fallback: post-send verification: reload profile and confirm Pending
          console.log('[actions] Verifying connection... waiting 30s for LinkedIn to process.');
          await new Promise(r => setTimeout(r, 30000));
          const currentUrl = page.url();
          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch { /* timeout OK */ }
          await new Promise(r => setTimeout(r, 5000));
          await page.evaluate(() => { document.body.style.zoom = '75%'; });
          if (await isPending(page)) {
            console.log('[actions] ✓ Verified: Pending (fallback send).');
            return { invitationUrn: null };
          }
          console.log('[actions] Not Pending yet. Waiting another 30s...');
          await new Promise(r => setTimeout(r, 30000));
          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch { /* */ }
          await new Promise(r => setTimeout(r, 5000));
          await page.evaluate(() => { document.body.style.zoom = '75%'; });
          if (await isPending(page)) {
            console.log('[actions] ✓ Verified: Pending (fallback send, 2nd check).');
            return { invitationUrn: null };
          }
          throw new Error('SEND_NOT_CONFIRMED: fallback send without note did not land as Pending');
        }
        console.log('[actions] Note typed and verified.');
        await new Promise(r => setTimeout(r, 5000));
      }

      // ── Click Send — all via JS ──
      let sent = false;

      if (!sent && modal.hasSendWithout && !note) {
        const r = await clickByAria(page, 'Send without a note');
        if (r) { sent = true; console.log(`[actions] ✓ "Send without a note" clicked (${r}).`); }
      }

      if (!sent && modal.hasSend) {
        const r = await clickByAria(page, 'Send');
        if (r) { sent = true; console.log(`[actions] ✓ "Send" clicked (${r}).`); }
      }

      if (!sent) {
        const r = await clickByAria(page, 'Send without a note');
        if (r) { sent = true; console.log(`[actions] ✓ "Send without a note" fallback (${r}).`); }
      }

      if (!sent) {
        const r = await clickByText(page, 'Send');
        if (r) { sent = true; console.log(`[actions] ✓ "Send" by text (${r}).`); }
      }

      if (!sent) {
        // Last resort: click any primary button in modal that isn't "Add" or "Cancel"
        sent = await page.evaluate(() => {
          const allBtns = [];
          allBtns.push(...Array.from(document.querySelectorAll('button')));
          const outlet = document.getElementById('interop-outlet');
          if (outlet?.shadowRoot) {
            allBtns.push(...Array.from(outlet.shadowRoot.querySelectorAll('button')));
          }
          for (const b of allBtns) {
            const cls = b.className?.toLowerCase() || '';
            const text = b.textContent?.trim().toLowerCase() || '';
            if (cls.includes('primary') && !text.includes('add') && !text.includes('cancel') && !text.includes('follow')) {
              b.click();
              return true;
            }
          }
          return false;
        });
        if (sent) console.log('[actions] ✓ Primary button fallback clicked.');
      }

      if (!sent) {
        const allBtns = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const outlet = document.getElementById('interop-outlet');
          if (outlet?.shadowRoot) btns.push(...Array.from(outlet.shadowRoot.querySelectorAll('button')));
          return btns.filter(b => b.offsetWidth > 0).map(b => ({
            text: b.textContent?.trim().substring(0, 30),
            aria: (b.getAttribute('aria-label') || '').substring(0, 40),
          }));
        });
        console.error('[actions] Send not found. Buttons:', JSON.stringify(allBtns.slice(0, 15)));
        throw new Error('Send button not found in modal');
      }

      // ── Approach A: Voyager network response (gold-standard signal) ──
      // The instant LinkedIn's backend replies to the invitation POST, we know
      // definitively whether it landed. This bypasses toast races and reload
      // latency. Wait up to 10s for the listener to fire.
      await new Promise(r => setTimeout(r, 1500));
      const voyagerMain = await voyagerCapture.waitFor(10000);
      if (voyagerMain) {
        if (voyagerMain.ok) {
          console.log(`[actions] ✓ Voyager confirmed: HTTP ${voyagerMain.status}, urn=${voyagerMain.urn || 'n/a'}`);
          return { invitationUrn: voyagerMain.urn };
        }
        console.error(`[actions] ✗ Voyager rejected: HTTP ${voyagerMain.status} — ${voyagerMain.errorMessage || ''}`);
        throw new Error(`VOYAGER_REJECTED: HTTP ${voyagerMain.status} — ${voyagerMain.errorMessage || 'unknown reason'}`);
      }
      console.log('[actions] Voyager listener did not fire in 10s — falling back to toast/Pending check.');

      // ── Legacy fallback: toast check ──
      // Check for success toast first: "Invitation sent to X"
      const sentToast = await page.evaluate(() => {
        const toasts = document.querySelectorAll('.artdeco-toast-item, [data-test-artdeco-toast-item-type="success"]');
        for (const t of toasts) {
          const text = (t.textContent || '').toLowerCase();
          if (text.includes('invitation sent')) return text.trim().substring(0, 100);
        }
        return null;
      });
      if (sentToast) {
        console.log(`[actions] ✓ Verified via toast: "${sentToast}"`);
        return { invitationUrn: null };
      }
      const errorToast = await page.evaluate(() => {
        const toast = document.querySelector(
          'div[data-test-artdeco-toast-item-type="error"], ' +
          '.artdeco-toast-item--error, ' +
          'li-icon[type="error"]'
        );
        if (toast) {
          const container = toast.closest('.artdeco-toast-item') || toast.parentElement;
          return (container?.textContent || toast.textContent || '').trim().substring(0, 200);
        }
        // Also check all Shadow DOM roots
        const roots = [];
        document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) roots.push(el.shadowRoot); });
        for (const root of roots) {
          const sToast = root.querySelector(
            'div[data-test-artdeco-toast-item-type="error"], .artdeco-toast-item--error'
          );
          if (sToast) {
            const container = sToast.closest('.artdeco-toast-item') || sToast.parentElement;
            return (container?.textContent || sToast.textContent || '').trim().substring(0, 200);
          }
        }
        return null;
      });
      if (errorToast) {
        console.error(`[actions] ⚠ LinkedIn error toast after send: "${errorToast}"`);
        throw new Error(`LINKEDIN_ERROR_TOAST: ${errorToast}`);
      }

      // ── Legacy fallback: reload + isPending ──
      console.log('[actions] Verifying connection... waiting 30s for LinkedIn to process.');
      await new Promise(r => setTimeout(r, 30000));
      const currentUrl = page.url();
      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch { /* timeout OK — page still usable */ }
      await new Promise(r => setTimeout(r, 5000));
      await page.evaluate(() => { document.body.style.zoom = '75%'; });

      if (await isPending(page)) {
        console.log('[actions] ✓ Verified: Pending.');
        return { invitationUrn: null };
      }

      console.log('[actions] Not Pending yet. Waiting another 30s...');
      await new Promise(r => setTimeout(r, 30000));
      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch { /* timeout OK */ }
      await new Promise(r => setTimeout(r, 5000));
      await page.evaluate(() => { document.body.style.zoom = '75%'; });

      if (await isPending(page)) {
        console.log('[actions] ✓ Verified: Pending (2nd check).');
        return { invitationUrn: null };
      }

      console.warn('[actions] ⚠ Send clicked but Pending NOT confirmed after 60s + 2 page reloads.');
      throw new Error('SEND_NOT_CONFIRMED: clicked Send but profile does not show Pending');
    }

    if (attempt < 8) {
      console.log(`[actions] No modal yet (${attempt}/8), waiting 3s…`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Debug dump
  const btns = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button'));
    for (const root of getAllShadowRoots()) {
      all.push(...Array.from(root.querySelectorAll('button')));
    }
    function getAllShadowRoots() {
      const roots = [];
      const outlet = document.getElementById('interop-outlet');
      if (outlet?.shadowRoot) roots.push(outlet.shadowRoot);
      // Search all elements with shadow roots
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot && el.id !== 'interop-outlet') roots.push(el.shadowRoot);
      });
      return roots;
    }
    return all.filter(b => b.offsetWidth > 0).slice(0, 12).map(b => ({
      text: b.textContent?.trim().substring(0, 25),
      aria: (b.getAttribute('aria-label') || '').substring(0, 35),
      src: b.getRootNode() === document ? 'dom' : 'shadow',
    }));
  });
  console.error('[actions] No modal after 8 attempts. Buttons:', JSON.stringify(btns));
  throw new Error('No modal appeared and connection not sent');
  } finally {
    voyagerCapture.detach();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// sendMessage
// ═════════════════════════════════════════════════════════════════════════════

export async function sendMessage(page, message) {
  // ── 2.8.48 — Compose-page navigation + plain Enter to send ──────────
  // History: tried injecting the LinkedIn DM Assistant content.js into the
  // page via a <script> tag — LinkedIn's CSP blocks inline scripts, so the
  // helpers never registered ("DM Assistant injection did not expose
  // helpers"). Tried clicking the profile's Message button to open the
  // floating bubble — getProfileMessageButton couldn't find it on every
  // profile (probably profiles where the running account isn't connected,
  // but unreliable either way).
  //
  // Going back to LinkedIn's dedicated compose URL and using plain Enter
  // to send. The compose page in Orbita has NO Send button (the only "send"
  // is an "Open send options" overflow), but pressing Enter on the
  // composer triggers send because the Ortus accounts have LinkedIn's
  // "Press Enter to send message" setting enabled.

  const currentUrl = page.url();
  const publicIdMatch = currentUrl.match(/\/in\/([^/?#]+)/);
  if (!publicIdMatch) {
    throw new Error(`MESSAGE_SEND_FAILED: not on a profile page (${currentUrl})`);
  }
  const publicId = publicIdMatch[1];

  const composeUrl = `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(publicId)}`;
  console.log(`[actions] Navigating to ${composeUrl}`);
  try {
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.warn(`[actions] Compose navigation warning: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 1500));

  // Wait for the compose textbox.
  const composeSelectors = [
    'div[role="textbox"][aria-label*="Write a message" i]',
    '.msg-form__contenteditable',
    'div[class*="msg-form__contenteditable"]',
  ];
  let composerReady = false;
  for (const sel of composeSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      composerReady = true;
      break;
    } catch { /* try next */ }
  }
  if (!composerReady) {
    throw new Error('MESSAGE_SEND_FAILED: compose textbox did not appear');
  }

  await randomDelay(150, 300);
  const typed = await typeIntoField(page, message);
  if (!typed) throw new Error('MESSAGE_SEND_FAILED: could not type message');

  // Let React register the input event.
  await new Promise(r => setTimeout(r, 700));

  // Try Send button first (some account/layout combos do render it).
  const sentByButton = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const activate = (el) => {
      el.scrollIntoView?.({ block: 'center' });
      el.focus?.();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    };

    // Tier 0 — data-test-icon
    const icon = document.querySelector('[data-test-icon*="send"]');
    const iconBtn = icon?.closest?.('button');
    if (iconBtn && isVisible(iconBtn)) return activate(iconBtn);

    // Tier 1 — aria-label
    for (const b of document.querySelectorAll('button[aria-label="Send" i], button[aria-label="Send message" i], button[aria-label="Send a message" i]')) {
      if (isVisible(b)) return activate(b);
    }

    // Tier 2 — exact text "Send" / "Send message"
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const t = (b.textContent || '').trim();
      if ((t === 'Send' || t === 'Send message') && isVisible(b)) return activate(b);
    }

    // Tier 3 — legacy class
    const legacy = document.querySelector(
      'button.msg-form__send-button, .msg-form__send-button, ' +
      'button[type="submit"][class*="msg-form"]'
    );
    if (legacy && isVisible(legacy)) return activate(legacy);

    return false;
  });

  if (!sentByButton) {
    console.log('[actions] No Send button on compose page — using plain Enter');
    // Focus composer and move caret to end before pressing Enter, so the
    // shortcut sends instead of inserting a newline mid-message.
    const focused = await page.evaluate(() => {
      const composer = document.querySelector(
        'div[role="textbox"][aria-label*="Write a message" i], ' +
        '.msg-form__contenteditable, ' +
        '.msg-form div[contenteditable="true"], ' +
        '[role="textbox"][contenteditable="true"]'
      );
      if (!composer) return false;
      composer.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* */ }
      return true;
    });
    if (!focused) {
      throw new Error('MESSAGE_SEND_FAILED: composer not focusable for Enter shortcut');
    }
    // PLAIN Enter — Ortus accounts have "Press Enter to send message" enabled.
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 250));
    // Cmd+Enter and Ctrl+Enter as belt-and-suspenders.
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
  } else {
    console.log('[actions] Clicked Send button on compose page');
  }

  // ── Honest verification (preserved from 2.8.46) ──
  // Old logic falsely returned "sent" whenever a class selector didn't
  // match. Now we require positive proof.
  await new Promise(r => setTimeout(r, 2500));
  const verified = await page.evaluate((sentText) => {
    const editor = document.querySelector(
      'div[role="textbox"][aria-label*="Write a message" i], ' +
      '.msg-form__contenteditable, ' +
      '.msg-form div[contenteditable="true"], ' +
      'div[contenteditable="true"][aria-label*="message" i]'
    );
    let composerEmpty = null;
    let editorText = '';
    if (editor) {
      editorText = (editor.textContent || editor.innerText || '').replace(/​/g, '').trim();
      composerEmpty = editorText.length === 0;
    }
    let foundInThread = false;
    const tail = (sentText || '').slice(-40).trim();
    if (tail.length >= 8) {
      const messages = document.querySelectorAll(
        '.msg-s-event-listitem, [class*="msg-s-event"], ' +
        '[class*="msg-event-listitem"], .msg-s-message-list-content li'
      );
      for (const m of messages) {
        if ((m.textContent || '').includes(tail)) { foundInThread = true; break; }
      }
    }
    return {
      composerEmpty,
      foundInThread,
      editorText: editorText.substring(0, 60),
      editorFound: !!editor,
    };
  }, message);

  const success = verified.composerEmpty === true || verified.foundInThread === true;
  if (!success) {
    const why = verified.editorFound
      ? `composer still has text: "${verified.editorText}"`
      : 'composer not found and message not in thread';
    throw new Error(`MESSAGE_SEND_FAILED: send not confirmed (${why})`);
  }
  console.log(`[actions] ✓ Message sent (composerEmpty=${verified.composerEmpty}, foundInThread=${verified.foundInThread})`);
}

// ═════════════════════════════════════════════════════════════════════════════
// sendIntroMessage — 2.8.50
// ═════════════════════════════════════════════════════════════════════════════
// Mirrors LinkedIn DM Assistant's Option+I flow. Same /messaging/compose/
// landing as sendMessage, plus:
//   1. Add the intro person as a second recipient (typeahead → exact match)
//   2. Fill the conversation title (group thread)
//   3. Type the body
//   4. Send (Send button → plain Enter fallback)
//
// Helper functions are ports of the DM Assistant's content.js
// (getRecipientSearchInputTarget, selectExactRecipientResult,
// getConversationTitleInputTarget, hasSelectedRecipient).
// ═════════════════════════════════════════════════════════════════════════════

export async function sendIntroMessage(page, body, introName, groupTitle, secondRecipientUrl = '') {
  if (!introName) throw new Error('MESSAGE_SEND_FAILED: introName required');

  const currentUrl = page.url();
  const publicIdMatch = currentUrl.match(/\/in\/([^/?#]+)/);
  if (!publicIdMatch) {
    throw new Error(`MESSAGE_SEND_FAILED: not on a profile page (${currentUrl})`);
  }
  const publicId = publicIdMatch[1];

  // v2.13.14: when the caller provides the second recipient's LinkedIn URL,
  // append a second `recipient=<publicId>` query param so LinkedIn auto-adds
  // BOTH pills via URL routing — same mechanism we use for the lead pill,
  // and the same mechanism the deleted preflight (verify-primary-person.js)
  // proved 100% reliable. The existing `alreadyAdded` check below then
  // detects the URL-added second pill and skips the unreliable typeahead
  // step entirely. Callers that don't pass the URL (e.g. the standalone
  // Introduce Back path) keep the typeahead behaviour byte-for-byte.
  let composeUrl = `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(publicId)}`;
  if (secondRecipientUrl) {
    const secondMatch = secondRecipientUrl.match(/\/in\/([^/?#]+)/);
    if (secondMatch) {
      composeUrl += `&recipient=${encodeURIComponent(secondMatch[1])}`;
    }
  }
  console.log(`[actions:intro] Navigating to ${composeUrl}`);
  try {
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.warn(`[actions:intro] Compose navigation warning: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 1500));

  // Wait for compose textbox.
  const composeSelectors = [
    'div[role="textbox"][aria-label*="Write a message" i]',
    '.msg-form__contenteditable',
    'div[class*="msg-form__contenteditable"]',
  ];
  let composerReady = false;
  for (const sel of composeSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      composerReady = true;
      break;
    } catch { /* try next */ }
  }
  if (!composerReady) throw new Error('MESSAGE_SEND_FAILED: compose textbox did not appear');

  // ── Step 1: add intro person as second recipient ──
  // v2.11.16: previous version dispatched a single synthetic InputEvent
  // after value-setting via the React-style native setter. That fires
  // React's onChange but LinkedIn's typeahead listens for real keystroke
  // events (keydown/keypress/input/keyup) with debounce — so the synthetic
  // single-shot dispatch never triggered the search XHR and the dropdown
  // never opened. Real-keystroke simulation via page.type fixes it.
  //
  // Strategy: tag the recipient input with a unique data-attribute inside
  // page.evaluate, then exit evaluate to use page.type which simulates
  // proper key sequences. Re-enter evaluate to wait for the dropdown and
  // verify the pill.
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
        el.setAttribute('data-ortus-recipient', '1');
        return {
          ok: true,
          tag: el.tagName,
          ariaLabel: el.getAttribute('aria-label') || '',
          placeholder: el.getAttribute('placeholder') || '',
          contentEditable: el.isContentEditable || false,
        };
      }
    }
    return { ok: false };
  });

  if (!tagged.ok) {
    throw new Error('INTRO_RECIPIENT_NOT_FOUND: recipient-input-not-found');
  }
  console.log(`[actions:intro] Recipient input found: ${tagged.tag} aria="${tagged.ariaLabel}" placeholder="${tagged.placeholder}" CE=${tagged.contentEditable}`);

  // Check if intro person is already added (idempotent)
  const alreadyAdded = await page.evaluate((name) => {
    const normalizeName = (v) => (v || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/^remove\s+/, '')
      .replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
    const norm = normalizeName(name);
    return Array.from(document.querySelectorAll(
      '.msg-connections-typeahead__added-recipients button[aria-label^="Remove"], button.artdeco-pill[aria-label^="Remove"]'
    )).some((b) => normalizeName(b.getAttribute('aria-label')).includes(norm));
  }, introName);

  if (alreadyAdded) {
    console.log('[actions:intro] Recipient already added — skipping typeahead');
  } else {
    // Real-keystroke typing. delay=60ms per char gives LinkedIn's debounce
    // time to register each char as the user types — exactly what the
    // typeahead listener expects.
    const recipientSelector = '[data-ortus-recipient="1"]';
    try {
      await page.click(recipientSelector);
      await page.evaluate(() => document.activeElement?.blur());
      await page.click(recipientSelector);
    } catch { /* focus is best-effort */ }
    await page.type(recipientSelector, introName, { delay: 60 });
    console.log(`[actions:intro] Typed recipient name with real keystrokes: "${introName}"`);

    // Wait for typeahead dropdown, click exact match.
    const clickResult = await page.evaluate(async (name) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
      };
      const activate = (el) => {
        el.scrollIntoView?.({ block: 'center' });
        el.focus?.();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
        el.click();
        return true;
      };
      const normalizeName = (v) => (v || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/^remove\s+/, '')
        .replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
      const norm = normalizeName(name);

      // 3-tier matcher (mirrors src/linkedin/match-primary.js — keep in sync).
      //   1. exact / startsWith
      //   2. token-prefix (each token in configured name must prefix some word in candidate)
      //   3. single-candidate fallback (only one suggestion: trust it)
      const matchOne = (cands) => {
        for (let i = 0; i < cands.length; i++) {
          const t = normalizeName(cands[i].innerText || cands[i].textContent);
          if (t === norm || t.startsWith(`${norm} `)) return { idx: i, reason: 'exact' };
        }
        const tokens = norm.split(/\s+/);
        for (let i = 0; i < cands.length; i++) {
          const t = normalizeName(cands[i].innerText || cands[i].textContent);
          const words = t.split(/\s+/);
          if (tokens.every(tok => words.some(w => w.startsWith(tok)))) {
            return { idx: i, reason: 'token-prefix' };
          }
        }
        if (cands.length === 1) return { idx: 0, reason: 'single-candidate' };
        return { idx: -1, reason: 'no-match' };
      };

      let lastCandidateCount = 0;
      let lastCandidatePreview = '';
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        const roots = Array.from(document.querySelectorAll(
          '.msg-connections-typeahead__search-results, [role="listbox"], .reusable-search__entity-result-list'
        ));
        const searchRoots = roots.length ? roots : [document];
        for (const root of searchRoots) {
          const candidates = Array.from(root.querySelectorAll(
            'li, [role="option"], button, .msg-connections-typeahead__search-result, .reusable-search__result-container'
          )).filter(isVisible);
          if (candidates.length > lastCandidateCount) {
            lastCandidateCount = candidates.length;
            lastCandidatePreview = candidates.slice(0, 3).map(c => (c.innerText || '').trim().split('\n')[0]).join(' | ');
          }
          const result = matchOne(candidates);
          if (result.idx >= 0) {
            activate(candidates[result.idx]);
            return { ok: true, candidateCount: candidates.length, preview: lastCandidatePreview, matchReason: result.reason };
          }
        }
      }
      return { ok: false, candidateCount: lastCandidateCount, preview: lastCandidatePreview };
    }, introName);

    console.log(`[actions:intro] Dropdown poll result: ok=${clickResult.ok} candidates=${clickResult.candidateCount} preview="${clickResult.preview}" matchReason=${clickResult.matchReason || 'n/a'}`);

    if (!clickResult.ok) {
      // Clean up the attribute before throwing
      await page.evaluate(() => document.querySelector('[data-ortus-recipient="1"]')?.removeAttribute('data-ortus-recipient'));
      const detail = clickResult.candidateCount === 0
        ? 'recipient-not-in-results (dropdown never opened — confirm 1st-degree connection)'
        : `recipient-not-in-results (${clickResult.candidateCount} suggestions but no match; saw: ${clickResult.preview})`;
      throw new Error(`INTRO_RECIPIENT_NOT_FOUND: ${detail}`);
    }

    // Verify the pill appeared
    await new Promise(r => setTimeout(r, 600));
    const verified = await page.evaluate((name) => {
      const normalizeName = (v) => (v || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/^remove\s+/, '')
        .replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
      const norm = normalizeName(name);
      return Array.from(document.querySelectorAll(
        '.msg-connections-typeahead__added-recipients button[aria-label^="Remove"], button.artdeco-pill[aria-label^="Remove"]'
      )).some((b) => normalizeName(b.getAttribute('aria-label')).includes(norm));
    }, introName);

    if (!verified) {
      await page.evaluate(() => document.querySelector('[data-ortus-recipient="1"]')?.removeAttribute('data-ortus-recipient'));
      throw new Error('INTRO_RECIPIENT_NOT_FOUND: recipient-pill-not-confirmed (clicked dropdown match but pill never appeared)');
    }
  }

  // Clean up the temporary tag attribute.
  await page.evaluate(() => document.querySelector('[data-ortus-recipient="1"]')?.removeAttribute('data-ortus-recipient'));
  console.log(`[actions:intro] Recipient added: ${introName} (alreadyAdded=${alreadyAdded})`);

  // ── Step 2: fill the conversation title (group thread) ──
  await new Promise(r => setTimeout(r, 600));
  const titleResult = await page.evaluate((title) => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    // DM Assistant's getConversationTitleInputTarget
    const candidates = Array.from(document.querySelectorAll('input, textarea')).filter(isVisible);
    const target = candidates.find((c) => {
      const text = [
        c.getAttribute('aria-label'),
        c.getAttribute('placeholder'),
        c.getAttribute('name'),
        c.getAttribute('id'),
        c.getAttribute('title'),
      ].join(' ').toLowerCase();
      return text.includes('subject') || text.includes('group name') || text.includes('thread');
    });
    if (!target) return { ok: false, reason: 'title-input-not-found' };
    target.focus();
    const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(target, title); else target.value = title;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: title }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, groupTitle);
  if (!titleResult.ok) {
    console.warn(`[actions:intro] Group title field not found (${titleResult.reason}) — proceeding without title`);
  } else {
    console.log(`[actions:intro] Group title set: ${groupTitle}`);
  }

  // ── Step 3: type body via existing typeIntoField (matches the regular composer) ──
  await randomDelay(150, 300);
  const typed = await typeIntoField(page, body);
  if (!typed) throw new Error('MESSAGE_SEND_FAILED: could not type body');

  await new Promise(r => setTimeout(r, 700));

  // ── Step 4: try Send button, fall back to plain Enter (same as sendMessage) ──
  const sentByButton = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const activate = (el) => {
      el.scrollIntoView?.({ block: 'center' });
      el.focus?.();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    };
    const icon = document.querySelector('[data-test-icon*="send"]');
    const iconBtn = icon?.closest?.('button');
    if (iconBtn && isVisible(iconBtn)) return activate(iconBtn);
    for (const b of document.querySelectorAll('button[aria-label="Send" i], button[aria-label="Send message" i], button[aria-label="Send a message" i]')) {
      if (isVisible(b)) return activate(b);
    }
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const t = (b.textContent || '').trim();
      if ((t === 'Send' || t === 'Send message') && isVisible(b)) return activate(b);
    }
    const legacy = document.querySelector('button.msg-form__send-button, .msg-form__send-button, button[type="submit"][class*="msg-form"]');
    if (legacy && isVisible(legacy)) return activate(legacy);
    return false;
  });

  if (!sentByButton) {
    console.log('[actions:intro] No Send button — using plain Enter');
    await page.evaluate(() => {
      const composer = document.querySelector(
        'div[role="textbox"][aria-label*="Write a message" i], ' +
        '.msg-form__contenteditable, ' +
        '.msg-form div[contenteditable="true"], ' +
        '[role="textbox"][contenteditable="true"]'
      );
      if (!composer) return;
      composer.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* */ }
    });
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 250));
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
  } else {
    console.log('[actions:intro] Clicked Send button');
  }

  // ── Step 5: honest verification (same as sendMessage) ──
  await new Promise(r => setTimeout(r, 2500));
  const verified = await page.evaluate((sentText) => {
    const editor = document.querySelector(
      'div[role="textbox"][aria-label*="Write a message" i], ' +
      '.msg-form__contenteditable, ' +
      '.msg-form div[contenteditable="true"], ' +
      'div[contenteditable="true"][aria-label*="message" i]'
    );
    let composerEmpty = null;
    let editorText = '';
    if (editor) {
      editorText = (editor.textContent || editor.innerText || '').replace(/​/g, '').trim();
      composerEmpty = editorText.length === 0;
    }
    let foundInThread = false;
    const tail = (sentText || '').slice(-40).trim();
    if (tail.length >= 8) {
      const messages = document.querySelectorAll(
        '.msg-s-event-listitem, [class*="msg-s-event"], ' +
        '[class*="msg-event-listitem"], .msg-s-message-list-content li'
      );
      for (const m of messages) {
        if ((m.textContent || '').includes(tail)) { foundInThread = true; break; }
      }
    }
    return { composerEmpty, foundInThread, editorText: editorText.substring(0, 60), editorFound: !!editor };
  }, body);

  const success = verified.composerEmpty === true || verified.foundInThread === true;
  if (!success) {
    const why = verified.editorFound
      ? `composer still has text: "${verified.editorText}"`
      : 'composer not found and message not in thread';
    throw new Error(`MESSAGE_SEND_FAILED: send not confirmed (${why})`);
  }
  console.log(`[actions:intro] ✓ Intro sent (composerEmpty=${verified.composerEmpty}, foundInThread=${verified.foundInThread})`);
}

// ═════════════════════════════════════════════════════════════════════════════
// resolveSalesNavUrlFromInProfile
// ═════════════════════════════════════════════════════════════════════════════
// Pure helper: clicks the More dropdown on a /in/ profile and extracts the
// "View in Sales Navigator" href via a three-tier lookup (dropdown-scoped
// anchor → any anchor with /sales/{lead,people}/ → text-match item with
// child a[href]). Does NOT navigate. Returns the absolute URL string on
// success or null on failure. Never throws — callers choose their own
// failure mode.
// ═════════════════════════════════════════════════════════════════════════════

export async function resolveSalesNavUrlFromInProfile(page) {
  console.log('[actions] resolveSalesNavUrlFromInProfile: opening More dropdown…');

  let moreOk = false;
  try {
    moreOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const more = btns.find(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const t = (b.textContent || '').trim().toLowerCase();
        return a === 'more actions' || a === 'more' || t === 'more';
      });
      if (more) { more.click(); return true; }
      return false;
    });
  } catch (e) {
    console.warn(`[actions] resolveSalesNavUrlFromInProfile: More click failed: ${e.message}`);
    return null;
  }

  if (!moreOk) {
    console.warn('[actions] resolveSalesNavUrlFromInProfile: More button not found');
    return null;
  }

  await new Promise(r => setTimeout(r, 2500));

  let salesNavUrl = null;
  try {
    salesNavUrl = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/sales/lead/') || href.includes('/sales/people/')) {
          const inDropdown = a.closest('.artdeco-dropdown__content, [role="menu"]');
          if (inDropdown) return a.href;
        }
      }
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/sales/lead/') || href.includes('/sales/people/')) return a.href;
      }
      const items = Array.from(document.querySelectorAll('[role="button"], .artdeco-dropdown__item, li'));
      for (const el of items) {
        const text = (el.textContent || '').trim();
        if (text.includes('View in Sales Navigator')) {
          const a = el.querySelector('a[href]');
          if (a) return a.href;
        }
      }
      return null;
    });
  } catch (e) {
    console.warn(`[actions] resolveSalesNavUrlFromInProfile: href extract failed: ${e.message}`);
    return null;
  }

  if (salesNavUrl) {
    console.log(`[actions] resolveSalesNavUrlFromInProfile: resolved → ${salesNavUrl}`);
  } else {
    console.warn('[actions] resolveSalesNavUrlFromInProfile: no Sales Nav href found in dropdown');
  }
  return salesNavUrl || null;
}

// ═════════════════════════════════════════════════════════════════════════════
// sendInMail
// ═════════════════════════════════════════════════════════════════════════════

export async function sendInMail(page, subject, message) {
  // InMail goes through Sales Navigator for both local and gologin accounts.
  // Path: More dropdown → extract Sales Nav href → page.goto(href) →
  // click Message on the Sales Nav lead page → type → Send.
  //
  // If caller already navigated to Sales Nav (performOutreach's upfront
  // conversion for OP/InMail modes), skip the internal resolve+goto —
  // backward-compatible for /in/ callers, no-op for Sales Nav callers.
  const alreadyOnSalesNav = SALES_NAV_URL_RE.test(page.url());
  if (!alreadyOnSalesNav) {
    const salesNavUrl = await resolveSalesNavUrlFromInProfile(page);
    if (!salesNavUrl) throw new Error('INMAIL_SEND_FAILED: View in Sales Navigator href not found');

    console.log(`[actions] Navigating to Sales Nav: ${salesNavUrl}`);
    try {
      await page.goto(salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.warn(`[actions] Sales Nav navigation issue: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  // Click Message on the Sales Nav lead page, inspect panel, type and send.
  // Uses the shared Sales Nav primitives defined below.
  const msgClicked = await clickSalesNavMessageButton(page);
  if (!msgClicked) throw new Error('INMAIL_SEND_FAILED: Sales Nav Message button missing');

  await new Promise(r => setTimeout(r, 3500));

  const panel = await readSalesNavComposerState(page);
  if (panel.creditsAvailable === 0) {
    throw new Error('INMAIL_NO_CREDITS: 0 InMail credits remaining — stopping InMail sends');
  }
  if (panel.creditsAvailable !== null) {
    console.log(`[actions] InMail credits available before send: ${panel.creditsAvailable}`);
  } else {
    console.warn('[actions] Could not read InMail credit counter (regex miss)');
  }

  const sendResult = await typeAndSendSalesNavComposer(page, subject, message);
  if (!sendResult.ok) throw new Error(`INMAIL_SEND_FAILED: ${sendResult.error}`);

  const creditsLeft = panel.creditsAvailable !== null ? Math.max(0, panel.creditsAvailable - 1) : null;
  console.log(`[actions] ✓ InMail sent via Sales Navigator. Credits remaining: ${creditsLeft ?? 'unknown'}`);
  return { creditsLeft };
}

// ═════════════════════════════════════════════════════════════════════════════
// Sales Nav router — shared primitives + entry point
// ═════════════════════════════════════════════════════════════════════════════
// Some sheets contain direct Sales Navigator URLs (linkedin.com/sales/people/…
// or /sales/lead/…) instead of standard /in/… profile URLs. The regular
// /in/-shaped status check + Open Profile / InMail flows misread the Sales
// Nav DOM. This router short-circuits both flows for Sales Nav URLs and
// drives the Sales Nav Message composer directly.
//
// The same three primitives are also reused by sendInMail, which ends up on a
// Sales Nav page via the /in/ More-dropdown. Zero duplicated Sales Nav logic.
// ═════════════════════════════════════════════════════════════════════════════

async function clickSalesNavMessageButton(page) {
  return await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    for (const b of btns) {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      if ((t === 'message' || aria.startsWith('message') || aria.includes('message')) && b.offsetWidth > 0) {
        b.click();
        return true;
      }
    }
    return false;
  });
}

async function readSalesNavComposerState(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const isFree = /free message/i.test(text);
    // Positive Open Profile signal — LinkedIn renders the literal badge text
    // "Free to Open Profile" in the Sales Nav message panel for free-send
    // targets. Using the presence of this badge (instead of the absence of
    // a credit counter) avoids false-positives when the panel renders without
    // a credit counter for non-OP reasons (slow render, A/B variant, etc.).
    const isFreeToOpenProfile = /free to open profile/i.test(text);
    const creditMatch = text.match(/Use\s+\d+\s+of\s+(\d+)\s+credits?/i);
    const hasCreditCounter = !!creditMatch;
    const creditsAvailable = creditMatch ? parseInt(creditMatch[1], 10) : null;
    const hasSubject = !!document.querySelector('input[name="subject"], input[aria-label*="Subject" i], input[placeholder*="Subject" i]');
    const hasCompose = !!document.querySelector(
      '.msg-form__contenteditable, ' +
      'div[role="textbox"][aria-label*="message" i], ' +
      'textarea[name="message"], ' +
      'textarea[aria-label*="type your message" i], ' +
      'form[data-x-conversation-widget="compose-form"] textarea'
    );
    // v2.11.3: when an account has 0 InMail credits AND the lead is NOT
    // Open Profile, Sales Nav renders the New-message panel without a
    // textbox and shows the literal copy "Sorry, you've used up all your
    // InMail credits" (body) and "No InMail credits left" (header). This
    // is a dual-fact signal: account is out of credits (eject for run)
    // AND the lead is confirmed non-OP (mark in sheet).
    const noInMailCredits =
      /sorry,?\s*you'?ve used up all your inmail credits/i.test(text) ||
      /no inmail credits left/i.test(text);
    return { isFree, isFreeToOpenProfile, hasCreditCounter, creditsAvailable, hasSubject, hasCompose, noInMailCredits };
  });
}

async function typeAndSendSalesNavComposer(page, subject, body) {
  // Subject (optional — Sales Nav paid panel has it; free panel sometimes doesn't)
  if (subject) {
    await page.evaluate((subj) => {
      const subjInput = document.querySelector('input[name="subject"], input[aria-label*="Subject" i], input[placeholder*="Subject" i]');
      if (!subjInput) return;
      subjInput.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(subjInput, subj);
      subjInput.dispatchEvent(new Event('input', { bubbles: true }));
      subjInput.dispatchEvent(new Event('change', { bubbles: true }));
    }, subject);
    await new Promise(r => setTimeout(r, 600));
  }

  const typedOk = await typeIntoField(page, body);
  if (!typedOk) return { ok: false, error: 'Could not type message (Sales Nav composer)' };

  await new Promise(r => setTimeout(r, 800));
  const sendOk = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const btns = Array.from(document.querySelectorAll('button'));
      const send = btns.find(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const isSend = t === 'send' || aria === 'send' || aria.startsWith('send ');
        const isDisabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
        return isSend && !isDisabled && b.offsetWidth > 0;
      });
      if (send) { send.click(); return true; }
      await sleep(150);
    }
    return false;
  });
  if (!sendOk) return { ok: false, error: 'Send button never enabled' };

  await new Promise(r => setTimeout(r, 3000));
  return { ok: true };
}

/**
 * Assumes the page is already on a Sales Nav URL
 * (linkedin.com/sales/people/… or /sales/lead/…).
 * Decision rules match the /in/ flow exactly:
 *   - force_open_profile : free panel → send, paid panel → do NOT send.
 *   - force_inmail       : free panel → send free (OP template),
 *                          paid panel → spend 1 credit (InMail template),
 *                          0 credits  → skip.
 *
 * Returns a status object; never throws.
 */
export async function sendViaSalesNav(page, { mode, opSubject, opBody, inmailSubject, inmailBody, connectionNote }) {
  console.log(`[actions] SalesNavRouter: mode=${mode} — looking for Message button on Sales Nav page…`);

  // For the connect-with-OP-fallback mode, a missing Message button is
  // acceptable — we'll jump straight to the overflow → Connect path.
  const clicked = await clickSalesNavMessageButton(page);
  if (!clicked && mode !== 'force_connect_op_fallback') return { ok: false, reason: 'message_button_not_found' };

  let panel = { hasCompose: false, hasCreditCounter: false, creditsAvailable: null, hasSubject: false, isFree: false };
  if (clicked) {
    await new Promise(r => setTimeout(r, 3500));
    panel = await readSalesNavComposerState(page);
    console.log(`[actions] SalesNavRouter panel: ${JSON.stringify(panel)}`);
  }

  // v2.11.3: dual-fact dialog detection — checked BEFORE the generic
  // hasCompose check because in this state hasCompose is also false but
  // the cause is specific and actionable (eject account + mark lead non-OP).
  if (panel.noInMailCredits) {
    return { ok: false, reason: 'inmail_no_credits_lead_not_op' };
  }

  // force_connect_op_fallback intentionally handles the no-composer case by
  // falling through to the "..." → Connect path, so skip the early bail.
  if (!panel.hasCompose && mode !== 'force_connect_op_fallback') {
    return { ok: false, reason: 'no_compose_textbox' };
  }

  if (mode === 'force_open_profile') {
    // Positive-signal gating: only send if the "Free to Open Profile" badge
    // is present. "No credit counter" is not proof of Open Profile — the
    // panel can render without a counter for transient/non-OP reasons.
    if (!panel.isFreeToOpenProfile) {
      return { ok: false, reason: 'not_open_profile' };
    }
    const result = await typeAndSendSalesNavComposer(page, opSubject, opBody);
    if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
    console.log('[actions] ✓ Sales Nav Open Profile message sent');
    return { ok: true, kind: 'op_message_sent' };
  }

  if (mode === 'force_inmail') {
    if (panel.isFreeToOpenProfile) {
      // Explicit OP badge — send free via the OP template.
      const result = await typeAndSendSalesNavComposer(page, opSubject, opBody);
      if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
      console.log('[actions] ✓ Sales Nav free message sent (InMail mode, OP path)');
      return { ok: true, kind: 'op_message_sent' };
    }
    if (panel.creditsAvailable === 0) {
      return { ok: false, reason: 'no_credits' };
    }
    const result = await typeAndSendSalesNavComposer(page, inmailSubject, inmailBody);
    if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
    const creditsLeft = panel.creditsAvailable !== null ? Math.max(0, panel.creditsAvailable - 1) : null;
    console.log(`[actions] ✓ Sales Nav InMail sent. Credits remaining: ${creditsLeft ?? 'unknown'}`);
    return { ok: true, kind: 'inmail_sent', creditsLeft };
  }

  if (mode === 'force_connect_op_fallback') {
    // Connection campaign + "Message OPs Directly": try Message → if the
    // "Free to Open Profile" badge is present, send OP; otherwise close
    // and fall through to "..." → Connect.
    if (clicked) {
      if (panel.hasCompose && panel.isFreeToOpenProfile) {
        const result = await typeAndSendSalesNavComposer(page, opSubject, opBody);
        if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
        console.log('[actions] ✓ Sales Nav OP message sent (connect-with-OP-fallback)');
        return { ok: true, kind: 'op_message_sent' };
      }
      // Paid InMail panel, no composer, or not OP — close before trying Connect.
      await closeSalesNavComposer(page);
      await new Promise(r => setTimeout(r, 1000));
    }

    const overflowOpen = await clickSalesNavOverflowMenu(page);
    if (!overflowOpen) return { ok: false, reason: 'unreachable', error: 'Overflow menu button not found' };
    await new Promise(r => setTimeout(r, 1500));

    const connectOpened = await clickSalesNavConnectMenuItem(page);
    if (!connectOpened) return { ok: false, reason: 'unreachable', error: 'Connect menu item not found' };
    await new Promise(r => setTimeout(r, 2500));

    const sent = await fillAndSendSalesNavConnectModal(page, connectionNote);
    if (!sent.ok) return { ok: false, reason: 'send_failed', error: sent.error };
    console.log('[actions] ✓ Sales Nav Connect request sent (OP fallback)');
    return { ok: true, kind: 'connection_sent' };
  }

  return { ok: false, reason: 'unknown_mode' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales Nav overflow-menu + Connect modal primitives
// ─────────────────────────────────────────────────────────────────────────────

async function clickSalesNavOverflowMenu(page) {
  return await page.evaluate(() => {
    const candidates = [
      'button[aria-label="Open actions overflow menu"]',
      'button[data-x--lead-actions-bar-overflow-menu]',
      'button[aria-haspopup="true"][aria-expanded="false"]',
    ];
    for (const sel of candidates) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetWidth > 0) { btn.click(); return true; }
    }
    return false;
  });
}

async function clickSalesNavConnectMenuItem(page) {
  // The overflow menu renders into #hue-web-menu-outlet and becomes visible
  // when .<something>_visible_... is added. We text-match "Connect" inside
  // the visible menu to find the option regardless of hashed class names.
  return await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const outlet = document.getElementById('hue-web-menu-outlet');
      if (outlet) {
        const menus = outlet.querySelectorAll('[class*="_visible_"]');
        for (const menu of menus) {
          const items = menu.querySelectorAll('li, button, [role="menuitem"], a');
          for (const item of items) {
            const txt = (item.textContent || '').trim();
            if (/^connect$/i.test(txt) && item.offsetWidth > 0) {
              item.click();
              return true;
            }
          }
        }
      }
      await sleep(150);
    }
    return false;
  });
}

async function fillAndSendSalesNavConnectModal(page, note) {
  // Fill the invitation note (optional) and click Send in .artdeco-modal__actionbar.
  if (note) {
    const filled = await page.evaluate((noteText) => {
      const ta = document.querySelector('#connect-cta-form__invitation, textarea[maxlength="300"]');
      if (!ta) return false;
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, noteText);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, note.slice(0, 300));
    if (!filled) return { ok: false, error: 'Connect modal note textarea not found' };
    await new Promise(r => setTimeout(r, 600));
  }

  const sent = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const bar = document.querySelector('.artdeco-modal__actionbar');
      if (bar) {
        const btns = Array.from(bar.querySelectorAll('button'));
        const send = btns.find(b => {
          const t = (b.textContent || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const isSend = t === 'send' || t === 'send invitation' || t === 'send now' || aria === 'send' || aria.startsWith('send ');
          const isDisabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
          return isSend && !isDisabled && b.offsetWidth > 0;
        });
        if (send) { send.click(); return true; }
      }
      await sleep(150);
    }
    return false;
  });
  if (!sent) return { ok: false, error: 'Send button never enabled in Connect modal' };

  await new Promise(r => setTimeout(r, 2500));
  return { ok: true };
}

async function closeSalesNavComposer(page) {
  // Close the message overlay before attempting Connect — the panel covers
  // the profile header which we need to click into.
  await page.evaluate(() => {
    const close = document.querySelector('button[aria-label*="Close" i][class*="_close_"], .msg-overlay-bubble-header__control[aria-label*="close" i]');
    if (close) { close.click(); return; }
    // Fallback: any visible close button inside the message overlay region
    const overlays = document.querySelectorAll('#message-overlay, [data-sn-view-name="subpage-message-overlay"]');
    for (const o of overlays) {
      const closeBtn = o.querySelector('button[aria-label*="close" i], button[aria-label*="dismiss" i]');
      if (closeBtn && closeBtn.offsetWidth > 0) { closeBtn.click(); return; }
    }
  });
}
