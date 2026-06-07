/**
 * v2.78 — Connect + Introduce "is this account connected to the primary?" check.
 *
 * The 3-way intro only makes sense when the SENDING account is a 1st-degree
 * connection of the primary person. Before a CC+IC account starts its turn we
 * navigate to the primary's profile, read the connection-degree badge, and — on
 * the first check only — send a bare connect request to the primary if the
 * account isn't already connected. While an account is unconnected its intros
 * are held (see campaign.js); each subsequent turn re-reads the degree and
 * releases the intros once it flips to 1st-degree.
 *
 * Pure browser helper: reuses the exported sendConnectionRequest. Does NOT
 * modify the off-limits action/outreach files.
 */
import { sendConnectionRequest } from './actions.js';

/**
 * Read the connection degree from a profile's top card.
 * Returns '1st' | '2nd' | '3rd' | 'self' | 'unknown'. Several selector
 * fallbacks because LinkedIn renders the distance badge a few different ways.
 */
export async function readPrimaryDegree(page, primaryUrl) {
  await page.goto(primaryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 2500)); // let the top card hydrate
  return await page.evaluate(() => {
    const norm = (el) => (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim().toLowerCase();
    const degreeFrom = (s) => {
      if (!s) return null;
      if (/\b1st\b|1st degree/.test(s)) return '1st';
      if (/\b2nd\b|2nd degree/.test(s)) return '2nd';
      if (/\b3rd\b|3rd degree/.test(s)) return '3rd';
      return null;
    };
    // 1) explicit distance badge
    const badge = document.querySelector('.dist-value, .distance-badge .dist-value, span.distance-badge, .pvs-profile-actions ~ * .dist-value');
    let d = degreeFrom(norm(badge));
    if (d) return d;
    // 2) top-card panel near the name
    const panel = document.querySelector('.pv-text-details__left-panel, .ph5.pb5, section.artdeco-card.pv-top-card, main section');
    d = degreeFrom(norm(panel));
    if (d) return d;
    // 3) header region around the <h1>
    const h1 = document.querySelector('h1');
    if (h1) {
      const around = norm(h1.closest('section') || h1.parentElement || h1);
      d = degreeFrom(around);
      if (d) return d;
      // "You" on your own profile → treat as self (no intro needed)
      if (/\byou\b/.test(around) && !/connect/.test(around)) return 'self';
    }
    return 'unknown';
  });
}

/**
 * Check (and optionally connect to) the primary from the current account's page.
 * @returns {{degree:string, connected:boolean, connectAttempted:boolean, connectResult?:string, error?:string}}
 */
export async function checkAndConnectPrimary(page, primaryUrl, { log = () => {}, pName = '', attemptConnect = true } = {}) {
  const out = { degree: 'unknown', connected: false, connectAttempted: false };
  if (!primaryUrl) return out;
  try {
    const degree = await readPrimaryDegree(page, primaryUrl);
    out.degree = degree;
    out.connected = (degree === '1st' || degree === 'self');
    if (out.connected) {
      log(`  🔗 [${pName}] Connected to primary (${degree}).`);
      return out;
    }
    if (!attemptConnect) {
      log(`  🔗 [${pName}] Still not connected to primary (degree=${degree}).`);
      return out;
    }
    log(`  🔗 [${pName}] Not connected to primary (degree=${degree}) — sending connect request to the primary.`);
    out.connectAttempted = true;
    try {
      await sendConnectionRequest(page); // bare request, no note
      out.connectResult = 'sent';
      log(`  🔗 [${pName}] Connect request sent to the primary.`);
    } catch (e) {
      out.connectResult = 'failed';
      out.error = e.message;
      log(`  ⚠ [${pName}] Connect to primary failed: ${e.message}`);
    }
  } catch (e) {
    out.error = e.message;
    log(`  ⚠ [${pName}] Primary connection check failed: ${e.message}`);
  }
  return out;
}
