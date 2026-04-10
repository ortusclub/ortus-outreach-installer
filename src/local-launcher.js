import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';

let activeBrowser = null;
let campaignPage = null; // Track the page WE opened

const REMOTE_DEBUG_PORT = 9222;

/**
 * Check if Chrome is running with remote debugging on port 9222.
 */
async function getDebugEndpoint() {
  try {
    const res = await fetch(`http://127.0.0.1:${REMOTE_DEBUG_PORT}/json/version`);
    const data = await res.json();
    return data.webSocketDebuggerUrl;
  } catch {
    return null;
  }
}

/**
 * Connect to the user's already-running Chrome via remote debugging.
 * Opens a new tab for the campaign — does not touch existing tabs.
 *
 * PREREQUISITE: Chrome must be running with --remote-debugging-port=9222.
 * One-time setup — see /api/local-browser/setup for the launch command.
 *
 * Returns { browser, page } — same interface as GoLogin launcher.
 */
export async function launchLocalBrowser() {
  console.log('[local] Connecting to your Chrome...');

  const wsUrl = await getDebugEndpoint();

  if (!wsUrl) {
    throw new Error(
      'Cannot connect to Chrome. You need to start Chrome with remote debugging enabled.\n\n' +
      'Run this command ONCE (close Chrome first, then run it):\n\n' +
      '  macOS:\n' +
      '  open -a "Google Chrome" --args --remote-debugging-port=9222\n\n' +
      '  Linux:\n' +
      '  google-chrome --remote-debugging-port=9222 &\n\n' +
      '  Windows:\n' +
      '  start chrome --remote-debugging-port=9222\n\n' +
      'After that, Local Browser campaigns will connect to it automatically.\n' +
      'Your Chrome works normally — the flag just allows Puppeteer to connect.'
    );
  }

  console.log('[local] Found Chrome with remote debugging on port 9222.');

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsUrl,
    ignoreHTTPSErrors: true,
    protocolTimeout: 60000,
  });

  activeBrowser = browser;

  // Open a NEW tab for the campaign — never hijacks existing tabs
  const page = await browser.newPage();
  campaignPage = page;

  await page.setViewport({ width: 1366, height: 900 });
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(15000);

  console.log('[local] ✓ Connected. New tab opened for campaign.');
  return { browser, page };
}

/**
 * Close only the campaign tab. Chrome stays running with all other tabs.
 */
export async function closeLocalBrowser() {
  if (!activeBrowser) return;

  try {
    // Only close the tab WE opened
    if (campaignPage) {
      try { await campaignPage.close(); } catch { /* */ }
      campaignPage = null;
    }

    // Disconnect Puppeteer — Chrome keeps running
    activeBrowser.disconnect();
    console.log('[local] Campaign tab closed. Chrome stays running.');
  } catch (err) {
    console.warn(`[local] Close warning: ${err.message}`);
  }

  activeBrowser = null;
}
