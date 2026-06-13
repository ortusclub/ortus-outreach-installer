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
import { getVoyagerDegree, getDegreeBadge } from './helpers.js';

/**
 * Read the connection degree to the profile at `primaryUrl`.
 * Returns '1st' | '2nd' | '3rd' | 'unknown'.
 *
 * v2.99: the old implementation scraped "1st"/"2nd"/"3rd" out of broad page
 * containers ('main section', the top-card panel, the header region). Those
 * containers also hold "People also viewed" / "More profiles for you" cards
 * whose entries carry the VIEWER's degree to *those* people — so a non-
 * connection routinely false-positived as '1st', the connect-to-primary gate
 * thought the account was already connected and skipped the connect, and the
 * intro then failed with INTRO_RECIPIENT_NOT_FOUND. We now use LinkedIn's
 * authoritative Voyager /networkinfo distance (viewer ↔ this exact profile),
 * with the careful slug-matched DOM badge as a fallback only when Voyager
 * returns nothing.
 */
export async function readPrimaryDegree(page, primaryUrl) {
  await page.goto(primaryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 2500)); // let the page hydrate

  // 1) Authoritative: Voyager networkinfo distance for the profile in the URL.
  try {
    const deg = await getVoyagerDegree(page);
    if (deg === 1) return '1st';
    if (deg === 2) return '2nd';
    if (deg === 3) return '3rd';
  } catch { /* fall through to DOM badge */ }

  // 2) Fallback: the slug-matched degree badge (rejects sidebar/recommendation
  //    matches), only consulted when Voyager gave us nothing.
  try {
    const badge = await getDegreeBadge(page);
    if (badge === '1st') return '1st';
    if (badge === '2nd') return '2nd';
    if (badge === '3rd' || badge === '3rd+') return '3rd';
  } catch { /* fall through */ }

  return 'unknown';
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
