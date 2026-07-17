/**
 * Pure helper for surfacing a cloud campaign's primary-session state
 * (c.primarySession = {state, name, parked}, Task 5) on the strips / card /
 * dashboard nudge. Only 'needs_login' shows anything — 'live' and 'none'
 * render nothing so there's no green noise on every strip.
 *
 * Lives in public/js so both app.js (browser, imported as an ES module) and
 * node --test can import it, same pattern as primary-url-validation.mjs /
 * note-hint.mjs.
 *
 * The returned `text` embeds the engine-provided `name` verbatim (untrusted,
 * NOT escaped here) — callers MUST escHtml() it before inserting into
 * innerHTML.
 */
export function primarySessionBadge(primarySession) {
  if (!primarySession || primarySession.state !== 'needs_login') return { show: false };
  const name = primarySession.name || 'the primary';
  return { show: true, text: `⚠ Primary needs login — ${name}`, cls: 'needs-login' };
}
