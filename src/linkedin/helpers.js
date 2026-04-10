/**
 * LinkedIn helpers — v18.
 * ALL clicks use element.click() via page.evaluate().
 * NEVER page.mouse.click(). No coordinates. No viewport dependencies.
 */

/**
 * Human-like delay using a skewed (log-normal-ish) distribution.
 * Clusters near the minimum, occasionally produces longer pauses —
 * mimics how humans actually behave (quick actions with occasional longer gaps).
 */
export function randomDelay(min = 500, max = 2000) {
  const u = Math.random();
  const skewed = Math.pow(u, 0.5); // sqrt gives right-skew: most values near min
  const ms = Math.floor(min + skewed * (max - min));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Collect all Shadow DOM roots on the page — not just interop-outlet.
 * LinkedIn may use multiple Shadow DOM containers.
 */
function getAllShadowRootsScript() {
  return `
    function __getAllShadowRoots() {
      const roots = [];
      const outlet = document.getElementById('interop-outlet');
      if (outlet?.shadowRoot) roots.push(outlet.shadowRoot);
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot && el.id !== 'interop-outlet') roots.push(el.shadowRoot);
      });
      return roots;
    }
  `;
}

/**
 * Click a button by aria-label — searches regular DOM AND all Shadow DOM roots.
 * Uses element.click() which works regardless of visibility or viewport.
 */
export async function clickByAria(page, ariaLabel) {
  return page.evaluate((label) => {
    // Regular DOM
    const btn = document.querySelector(`button[aria-label="${label}"]`);
    if (btn) { btn.click(); return 'dom'; }

    // All Shadow DOM roots
    const roots = [];
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.shadowRoot) roots.push(outlet.shadowRoot);
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot && el.id !== 'interop-outlet') roots.push(el.shadowRoot);
    });
    for (const root of roots) {
      const sBtn = root.querySelector(`button[aria-label="${label}"]`);
      if (sBtn) { sBtn.click(); return 'shadow'; }
    }

    return null;
  }, ariaLabel);
}

/**
 * Click a button by its exact text content — searches regular DOM + all Shadow DOMs.
 */
export async function clickByText(page, text) {
  return page.evaluate((t) => {
    // Regular DOM
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent?.trim() === t);
    if (btn) { btn.click(); return 'dom'; }

    // All Shadow DOM roots
    const roots = [];
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.shadowRoot) roots.push(outlet.shadowRoot);
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot && el.id !== 'interop-outlet') roots.push(el.shadowRoot);
    });
    for (const root of roots) {
      const sBtns = Array.from(root.querySelectorAll('button'));
      const sBtn = sBtns.find(b => b.textContent?.trim() === t);
      if (sBtn) { sBtn.click(); return 'shadow'; }
    }

    return null;
  }, text);
}

/**
 * Find a button by text and click it via JS (regular DOM only).
 */
export async function findButtonByText(page, text) {
  const byAria = await page.$(`button[aria-label*="${text}"]`);
  if (byAria) return byAria;

  const byText = await page.evaluateHandle((t) => {
    return Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === t) || null;
  }, text);
  return byText.asElement();
}

/**
 * Get connection status. Uses aria-label + text only.
 */
export async function getConnectionStatus(page) {
  try {
    const result = await page.evaluate(() => {
      // Profile name
      let profileName = '';
      const h1 = document.querySelector('h1');
      if (h1) profileName = h1.textContent.trim().split('\n')[0].trim();
      if (!profileName) {
        const m = (document.title || '').match(/^(.+?)(?:\s*[\|–-]\s*LinkedIn)?$/);
        if (m) profileName = m[1].trim();
      }

      // Collect ALL clickable elements from everywhere
      const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));

      // Search ALL Shadow DOM roots (not just interop-outlet)
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          els.push(...Array.from(el.shadowRoot.querySelectorAll('button, a, [role="button"]')));
        }
      });

      // Build a list of action-relevant elements for debugging
      const actionEls = [];
      for (const el of els) {
        const aria = el.getAttribute('aria-label') || '';
        const text = (el.textContent || '').trim();
        const tag = el.tagName;

        // Skip nav bar "Messaging" and "My Network" links
        if (aria === 'Messaging' || text === 'Messaging') continue;
        if (aria.includes('My Network')) continue;

        // Check if this element is relevant
        const ariaLow = aria.toLowerCase();
        const textLow = text.toLowerCase();

        if (ariaLow.includes('message') || textLow === 'message' ||
            ariaLow.includes('connect') || ariaLow.includes('invite') || textLow === 'connect' ||
            ariaLow.includes('follow') || textLow === 'follow' ||
            ariaLow.includes('pending') || textLow === 'pending') {
          actionEls.push({ tag, text: text.substring(0, 40), aria: aria.substring(0, 60) });
        }
      }

      // 1. Pending
      for (const el of els) {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        const t = (el.textContent || '').trim().toLowerCase();
        if (t === 'pending' || a.includes('pending')) {
          return { status: 'pending', debug: actionEls, profileName };
        }
      }

      // 2. Connect — CHECK BEFORE MESSAGE (navbar always has a Message icon)
      //    aria-label "Invite X to connect"
      for (const el of els) {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        if (a.includes('invite') && a.includes('to connect')) {
          return { status: 'connect', debug: actionEls, profileName };
        }
      }
      //    Fallback: button/a with exact text "Connect" (new LinkedIn UI)
      for (const el of els) {
        const t = (el.textContent || '').trim();
        if (t === 'Connect' && (el.tagName === 'BUTTON' || el.tagName === 'A')) {
          if (el.offsetWidth > 30) {
            return { status: 'connect', debug: actionEls, profileName };
          }
        }
      }

      // 3. Message — only AFTER confirming Connect is NOT present
      //    "Message X" aria on profile action button (NOT navbar)
      for (const el of els) {
        const aria = el.getAttribute('aria-label') || '';
        // Must be "Message <name>" (space + name), not just "Message" alone
        // The navbar icon has aria="Message" or is inside a nav element
        if (aria.startsWith('Message ') && aria.length > 10) {
          // Extra check: must NOT be inside a nav/header element
          const inNav = el.closest('nav, header, [role="navigation"]');
          if (!inNav) {
            return { status: 'message', debug: actionEls, profileName };
          }
        }
      }
      // Fallback: text is exactly "Message" on a profile action button
      for (const el of els) {
        const t = (el.textContent || '').trim();
        const aria = (el.getAttribute('aria-label') || '');
        if (t === 'Message' && aria !== 'Messaging' && !aria.includes('new notification')) {
          // Must NOT be inside navbar
          const inNav = el.closest('nav, header, [role="navigation"]');
          if (!inNav) {
            return { status: 'message', debug: actionEls, profileName };
          }
        }
      }

      // 4. Follow — aria starts with "Follow "
      for (const el of els) {
        const aria = el.getAttribute('aria-label') || '';
        if (aria.startsWith('Follow ')) {
          return { status: 'follow', debug: actionEls, profileName };
        }
      }

      return { status: 'unknown', debug: actionEls, profileName };
    });

    console.log(`[helpers] Status: ${result.status} (name: "${result.profileName || '?'}")`);
    if (result.debug.length > 0) {
      console.log('[helpers] Action elements:', JSON.stringify(result.debug));
    } else {
      console.log('[helpers] WARNING: No action elements found on page at all');
    }
    return result.status;
  } catch (err) {
    console.warn(`[helpers] Error: ${err.message}`);
    return 'unknown';
  }
}

export function personalizeTemplate(template, data = {}) {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return result.replace(/\{[a-zA-Z0-9_ ]+\}/g, '').trim();
}
