/**
 * Central FG roster / connections service endpoint.
 *
 * Hard-coded (like scraper-engine-url.js) so EVERY build / DMG points at the
 * central roster service by default — no per-operator .env needed. Remote
 * operators (whose DMG has no local connections DB) reach the FG roster and
 * Connections Search through here.
 *
 * FG_ROSTER_URL / FG_ROSTER_TOKEN env vars override these for local dev
 * (e.g. http://localhost:8080/fg-roster).
 */
export const FG_ROSTER_URL = process.env.FG_ROSTER_URL || 'https://scraper.ortusclub.com/fg-roster';
export const FG_ROSTER_TOKEN = process.env.FG_ROSTER_TOKEN || 'ortus2026scraper';
