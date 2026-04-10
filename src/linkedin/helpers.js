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

      // ── 0. Degree badge check — most reliable "already connected" signal ──
      // "1st" badge means already connected. Present near the name on all profile layouts.
      let degree = null;
      const degreeEl = document.querySelector('.dist-value, .distance-badge, span[class*="degree"]');
      if (degreeEl) {
        degree = degreeEl.textContent.trim();
      }
      // Fallback: search for "1st", "2nd", "3rd" text near the h1 name
      if (!degree) {
        const nameSection = document.querySelector('main .pv-text-details__left-panel, main [class*="top-card"]');
        if (nameSection) {
          const spans = nameSection.querySelectorAll('span');
          for (const s of spans) {
            const t = s.textContent.trim();
            if (t === '1st' || t === '2nd' || t === '3rd' || t === '3rd+') {
              degree = t;
              break;
            }
          }
        }
      }
      // Last resort: any small span on the page with just "1st"/"2nd"/"3rd"
      if (!degree) {
        const allSpans = document.querySelectorAll('span');
        for (const s of allSpans) {
          const t = s.textContent.trim();
          if ((t === '1st' || t === '2nd' || t === '3rd' || t === '3rd+') && s.offsetWidth > 0 && s.offsetWidth < 50) {
            degree = t;
            break;
          }
        }
      }

      // If "1st" degree → already connected, return 'message' status
      if (degree === '1st') {
        return { status: 'message', debug: actionEls, profileName, degree };
      }

      // ── 1. Pending — scoped to THIS profile only ──
      const firstName = profileName.split(/\s+/)[0]?.toLowerCase() || '';
      for (const el of els) {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        const t = (el.textContent || '').trim().toLowerCase();
        if (t === 'pending' || a.includes('pending')) {
          // Check if this Pending button is for the profile owner
          // aria-label like "Pending, click to withdraw invitation sent to Isaac"
          if (a.includes('pending') && firstName && !a.includes(firstName)) {
            continue; // This is a Pending button for someone else (recommendations)
          }
          // If it's just text "Pending" with no aria, check position (top section only)
          if (!a.includes('pending')) {
            const rect = el.getBoundingClientRect();
            if (rect.top > 800) continue; // Below the fold — probably recommendations
          }
          return { status: 'pending', debug: actionEls, profileName, degree };
        }
      }

      // ── 2. Connect — scoped to THIS profile's buttons only ──
      for (const el of els) {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        if (a.includes('invite') && a.includes('to connect')) {
          // Only count if it matches this profile's name, or there's only one such button
          if (firstName && a.includes(firstName)) {
            return { status: 'connect', debug: actionEls, profileName, degree };
          }
        }
      }
      //    If only one "Invite to connect" exists, it's this profile's
      const allInvites = els.filter(el => {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        return a.includes('invite') && a.includes('to connect');
      });
      if (allInvites.length === 1) {
        return { status: 'connect', debug: actionEls, profileName, degree };
      }
      //    Fallback: button/a with text "Connect" in the top section only
      for (const el of els) {
        const t = (el.textContent || '').trim();
        if (t === 'Connect' && (el.tagName === 'BUTTON' || el.tagName === 'A')) {
          if (el.offsetWidth > 30) {
            const rect = el.getBoundingClientRect();
            if (rect.top < 800) {
              return { status: 'connect', debug: actionEls, profileName, degree };
            }
          }
        }
      }

      // ── 3. Follow — aria starts with "Follow " ──
      for (const el of els) {
        const aria = el.getAttribute('aria-label') || '';
        if (aria.startsWith('Follow ')) {
          return { status: 'follow', debug: actionEls, profileName, degree };
        }
      }

      // ── 4. Message — last resort, only if no Connect and no degree badge ──
      //    "Message X" aria on profile action button (NOT navbar)
      for (const el of els) {
        const aria = el.getAttribute('aria-label') || '';
        if (aria.startsWith('Message ') && aria.length > 10) {
          const inNav = el.closest('nav, header, [role="navigation"]');
          if (!inNav) {
            return { status: 'message', debug: actionEls, profileName, degree };
          }
        }
      }
      // Fallback: text is exactly "Message" on a profile action button
      for (const el of els) {
        const t = (el.textContent || '').trim();
        const aria = (el.getAttribute('aria-label') || '');
        if (t === 'Message' && aria !== 'Messaging' && !aria.includes('new notification')) {
          const inNav = el.closest('nav, header, [role="navigation"]');
          if (!inNav) {
            return { status: 'message', debug: actionEls, profileName, degree };
          }
        }
      }

      return { status: 'unknown', debug: actionEls, profileName, degree };
    });

    console.log(`[helpers] Status: ${result.status} (name: "${result.profileName || '?'}", degree: ${result.degree || '?'})`);
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
