import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { spawn, execSync } from 'child_process';

let activeBrowser = null;

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
 * Kill any running Chrome instances so we can relaunch with debugging.
 */
function killExistingChrome() {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync('pkill -f "Google Chrome" 2>/dev/null || true');
    } else if (platform === 'win32') {
      execSync('taskkill /F /IM chrome.exe 2>nul || exit 0');
    } else {
      execSync('pkill -f chrome 2>/dev/null || true');
    }
    console.log('[local] Closed existing Chrome instances.');
  } catch {
    // Ignore — Chrome may not have been running
  }
}

/**
 * Launch Chrome with remote debugging using the user's default profile.
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

  const args = [
    `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    // Launch off-screen like GoLogin does — doesn't steal focus
    '--window-position=-2400,-2400',
    '--window-size=1366,900',
  ];

  console.log(`[local] Launching Chrome: ${chromePath}`);
  console.log(`[local] User data dir: ${userDataDir}`);

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
  } else {
    // Step 2: Kill existing Chrome (can't add debugging to running instance)
    const chromePath = process.env.CHROME_PATH || findChromePath();
    if (!chromePath) {
      throw new Error(
        'No Chrome/Chromium found. Set CHROME_PATH in .env or install Chrome.'
      );
    }

    console.log('[local] No remote debugging found. Closing existing Chrome and relaunching...');
    killExistingChrome();

    // Brief pause for Chrome to fully close
    await new Promise(r => setTimeout(r, 2000));

    // Step 3: Launch Chrome with debugging enabled
    launchChromeWithDebugging(chromePath);

    // Wait for Chrome to start and expose the debug endpoint
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      wsUrl = await getDebugEndpoint();
      if (wsUrl) break;
      console.log(`[local] Waiting for Chrome debug port... (${(i + 1) * 2}s)`);
    }

    if (!wsUrl) {
      throw new Error(
        `Chrome launched but debug port ${REMOTE_DEBUG_PORT} not responding after 40s.`
      );
    }
  }

  // Step 4: Connect via Puppeteer
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
 * Only closes campaign tabs — does NOT close Chrome itself.
 */
export async function closeLocalBrowser() {
  if (!activeBrowser) return;

  try {
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
