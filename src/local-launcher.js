import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

let activeBrowser = null;
let launchedChrome = false; // Track if WE launched Chrome or connected to existing

const REMOTE_DEBUG_PORT = 9222;

/**
 * Find Chrome executable path based on OS.
 */
function findChromePath() {
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Check if Chrome is already running with remote debugging enabled.
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
 * Launch Chrome with remote debugging using the user's default profile.
 * If Chrome is already running, it'll open a new window in the existing process.
 */
function launchChromeWithDebugging(chromePath) {
  const platform = process.platform;
  let userDataDir;

  if (platform === 'darwin') {
    userDataDir = `${process.env.HOME}/Library/Application Support/Google/Chrome`;
  } else if (platform === 'win32') {
    userDataDir = `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`;
  } else {
    userDataDir = `${process.env.HOME}/.config/google-chrome`;
  }

  // Launch Chrome with remote debugging on the user's default profile
  const args = [
    `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1366,900',
  ];

  const cmd = `"${chromePath}" ${args.map(a => `"${a}"`).join(' ')}`;
  console.log(`[local] Launching Chrome: ${chromePath}`);
  console.log(`[local] User data dir: ${userDataDir}`);

  // Launch detached so it doesn't block
  const { spawn } = require('child_process');
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return child;
}

/**
 * Launch or connect to local Chrome with the user's default profile.
 * Returns { browser, page } — same interface as GoLogin launcher.
 */
export async function launchLocalBrowser() {
  console.log('[local] Starting local browser...');

  // Step 1: Check if Chrome is already running with debugging
  let wsUrl = await getDebugEndpoint();

  if (wsUrl) {
    console.log('[local] Found existing Chrome with remote debugging.');
    launchedChrome = false;
  } else {
    // Step 2: Launch Chrome with remote debugging
    const chromePath = process.env.CHROME_PATH || findChromePath();
    if (!chromePath) {
      throw new Error(
        'No Chrome/Chromium found. Set CHROME_PATH in .env or install Chrome.'
      );
    }

    // Close any existing Chrome first (it won't have debugging enabled)
    console.log('[local] No remote debugging found. Launching Chrome with debugging...');
    console.log('[local] NOTE: If Chrome is already open, please close it first so we can relaunch with debugging enabled.');

    launchChromeWithDebugging(chromePath);
    launchedChrome = true;

    // Wait for Chrome to start and expose the debug endpoint
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      wsUrl = await getDebugEndpoint();
      if (wsUrl) break;
      console.log(`[local] Waiting for Chrome debug port... (${(i + 1) * 2}s)`);
    }

    if (!wsUrl) {
      throw new Error(
        `Chrome launched but debug port ${REMOTE_DEBUG_PORT} not responding after 30s.\n` +
        'Close ALL Chrome windows and try again — Chrome must start fresh with debugging enabled.'
      );
    }
  }

  // Step 3: Connect via Puppeteer
  console.log(`[local] Connecting to Chrome: ${wsUrl}`);
  const browser = await puppeteer.connect({
    browserWSEndpoint: wsUrl,
    ignoreHTTPSErrors: true,
    protocolTimeout: 60000,
  });

  activeBrowser = browser;

  // Open a new tab for the campaign (don't hijack existing tabs)
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(15000);

  console.log('[local] ✓ Connected to Chrome with your default profile.');
  return { browser, page };
}

/**
 * Close the local browser connection.
 * Only closes the campaign tab — does NOT close Chrome itself.
 */
export async function closeLocalBrowser() {
  if (!activeBrowser) return;

  try {
    // Close only the pages WE opened, don't kill the user's browser
    const pages = await activeBrowser.pages();
    for (const p of pages) {
      const url = p.url();
      // Close LinkedIn tabs opened by the campaign, leave others alone
      if (url.includes('linkedin.com')) {
        try { await p.close(); } catch { /* ignore */ }
      }
    }

    // Disconnect (don't close) — keep Chrome running for the user
    activeBrowser.disconnect();
    console.log('[local] Disconnected from Chrome (browser stays open).');
  } catch (err) {
    console.warn(`[local] Close warning: ${err.message}`);
  }

  activeBrowser = null;
}
