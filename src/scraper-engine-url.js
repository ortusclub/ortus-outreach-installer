/**
 * Centralized Sales Nav Scrape engine endpoint.
 *
 * Hard-coded (like sheets-webapp-url.js) so EVERY build / DMG points at the
 * cloud scraper engine by default — no per-operator .env needed. Whoever
 * installs the app scrapes on the cloud out of the box.
 *
 * A local SCRAPER_ENGINE_URL / SCRAPER_ENGINE_TOKEN env var still overrides
 * these for development/testing (e.g. http://localhost:3000).
 */

// The single cloud engine every operator's app talks to. scraper-client.js
// reads these as the DEFAULT and lets a SCRAPER_ENGINE_URL env var override
// them for local development.
export const SCRAPER_ENGINE_URL = 'https://scraper.ortusclub.com';

// Shared service token the app sends as a Bearer to the engine (matches the
// engine's ENGINE_SHARED_TOKEN, which defaults to its APP_PASSWORD). Embedded
// so the bundled app authenticates with the cloud engine without any setup.
export const SCRAPER_ENGINE_TOKEN = 'ortus2026scraper';
