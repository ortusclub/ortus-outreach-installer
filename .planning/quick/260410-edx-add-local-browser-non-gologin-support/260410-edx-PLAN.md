---
id: 260410-edx
type: quick
tasks: 3
autonomous: true
files_modified:
  - src/local-launcher.js
  - src/campaign.js
  - server.js
  - public/js/app.js
  - public/css/style.css
  - .env.example
---

<objective>
Add local browser (non-GoLogin) support so campaigns can run from a standard Chrome/Chromium
with a persistent user data directory. This gives operators a zero-dependency alternative
when GoLogin is not needed.

Purpose: Allow running campaigns without a GoLogin account by using the system Chrome.
Output: New `src/local-launcher.js`, updated campaign routing, dashboard "Local Browser" option.
</objective>

<context>
@src/gologin-launcher.js (interface contract: launchProfile returns {browser, page}, closeProfile(id))
@src/campaign.js (lines 258-280 for launch, 515-535 for close, line 24 for imports)
@server.js (lines 348-367 for graceful shutdown)
@public/js/app.js (renderProfiles function, lines 34-66)
@public/css/style.css
@.env.example
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create src/local-launcher.js</name>
  <files>src/local-launcher.js</files>
  <action>
Create `src/local-launcher.js` that provides the same interface shape as gologin-launcher.js
but uses puppeteer-core to launch a local Chrome/Chromium instance.

Exports:
- `launchLocalBrowser()` -- returns `{ browser, page }` (same shape as `launchProfile`)
- `closeLocalBrowser()` -- closes the active local browser (same role as `closeProfile`)

Implementation details:
- Import `puppeteer` from `puppeteer-core`, `existsSync`/`mkdirSync` from `fs`, `resolve` from `path`
- `LOCAL_PROFILE_DIR = resolve('./data/local-profile')` for persistent cookies/session
- Module-level `let activeBrowser = null` to track the single local browser instance
- `findChromePath()` helper that checks common paths in order:
  - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/Applications/Chromium.app/Contents/MacOS/Chromium`
  - Linux: `/usr/bin/google-chrome`, `/usr/bin/chromium-browser`, `/usr/bin/chromium`
  - Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
  - Returns first path that exists, or null
- `launchLocalBrowser()`:
  - Create LOCAL_PROFILE_DIR if missing (recursive)
  - Resolve executable: `process.env.CHROME_PATH || findChromePath()`
  - Throw descriptive error if no Chrome found
  - `puppeteer.launch()` with: `executablePath`, `headless: false`, `userDataDir: LOCAL_PROFILE_DIR`, `args: ['--window-size=1366,900', '--no-first-run', '--no-default-browser-check']`, `ignoreHTTPSErrors: true`, `protocolTimeout: 60000`
  - Store browser in `activeBrowser`
  - Get first existing page or create new one
  - Set viewport 1366x900, navigation timeout 30s, default timeout 15s
  - Return `{ browser, page }`
- `closeLocalBrowser()`:
  - If no activeBrowser, return early
  - Close all pages, then browser.close(), wrapped in try/catch with console.warn
  - Set activeBrowser = null

CRITICAL: Do NOT import or depend on GoLogin SDK. This is a standalone alternative launcher.
  </action>
  <verify>
    <automated>node -e "import('./src/local-launcher.js').then(m => { console.log('exports:', Object.keys(m)); if (!m.launchLocalBrowser || !m.closeLocalBrowser) throw new Error('Missing exports'); console.log('OK'); })"</automated>
  </verify>
  <done>src/local-launcher.js exists, exports launchLocalBrowser and closeLocalBrowser, imports cleanly without errors</done>
</task>

<task type="auto">
  <name>Task 2: Route campaign.js and server.js between GoLogin and local launcher</name>
  <files>src/campaign.js, server.js</files>
  <action>
**In src/campaign.js:**

1. Add import at top (after the existing gologin-launcher import on line 24):
   ```
   import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
   ```

2. In the profile name loading loop (lines 259-262), add a guard for `local-browser`:
   ```javascript
   for (const pid of profileIds) {
     if (pid === 'local-browser') {
       profileNameCache[pid] = 'Local Browser';
     } else {
       await getProfileName(pid, token);
     }
   }
   ```

3. In STEP 1 (line 280), replace the direct `launchProfile` call with conditional routing:
   ```javascript
   let launched;
   if (profileId === 'local-browser') {
     launched = await launchLocalBrowser();
   } else {
     launched = await launchProfile(profileId, token);
   }
   browser = launched.browser;
   ```
   Keep `let page = launched.page;` on the next line (line 286) unchanged.

4. In STEP 6 (line 529), add conditional close routing. After `await browser.close().catch(() => {});` on line 528, replace line 529:
   ```javascript
   if (profileId === 'local-browser') {
     await closeLocalBrowser();
   } else {
     await closeProfile(profileId);
   }
   ```

CRITICAL: Do NOT change any other part of campaign.js. The campaign loop, LinkedIn actions,
sheet operations, and outreach flow must remain completely untouched.

**In server.js:**

1. Add import (after line 19's gologin-launcher import):
   ```
   import { closeLocalBrowser } from './src/local-launcher.js';
   ```

2. In `gracefulShutdown()` (line 360), after `closeAllProfiles()` call, add:
   ```javascript
   await closeLocalBrowser();
   ```
   So the shutdown sequence becomes: stopCampaign -> wait -> closeAllProfiles -> closeLocalBrowser -> exit.
  </action>
  <verify>
    <automated>node -e "import('./src/campaign.js').then(() => console.log('campaign.js imports OK'))" && node -e "import('./server.js').catch(e => { if (e.message.includes('listen') || e.message.includes('EADDRINUSE') || e.message.includes('PORT')) console.log('server.js imports OK (port conflict expected)'); else throw e; })"</automated>
  </verify>
  <done>campaign.js routes to local launcher when profileId is 'local-browser', falls through to GoLogin for all other profiles. server.js closes local browser on shutdown. No other campaign logic changed.</done>
</task>

<task type="auto">
  <name>Task 3: Add Local Browser option to dashboard UI</name>
  <files>public/js/app.js, public/css/style.css, .env.example</files>
  <action>
**In public/js/app.js -- renderProfiles() function (line 34-66):**

After `grid.innerHTML = '';` (line 36), insert a block that prepends a "Local Browser" card
before the GoLogin profiles loop. The card uses the same structure as GoLogin profile items
but with `value="local-browser"` and a distinct subtitle.

```javascript
// Add Local Browser option at the top
const localItem = document.createElement('label');
localItem.className = 'profile-item local-browser' + (selectedProfileIds.includes('local-browser') ? ' selected' : '');
localItem.dataset.profileId = 'local-browser';
localItem.innerHTML = `
  <input type="checkbox" value="local-browser" ${selectedProfileIds.includes('local-browser') ? 'checked' : ''} />
  <div>
    <div class="name">Local Browser</div>
    <div class="id">Uses your system Chrome -- no GoLogin needed</div>
  </div>
`;
const localCb = localItem.querySelector('input');
localCb.addEventListener('change', () => {
  if (localCb.checked) {
    if (!selectedProfileIds.includes('local-browser')) {
      selectedProfileIds.push('local-browser');
      selectedProfileNames['local-browser'] = 'Local Browser';
    }
    localItem.classList.add('selected');
  } else {
    selectedProfileIds = selectedProfileIds.filter(id => id !== 'local-browser');
    delete selectedProfileNames['local-browser'];
    localItem.classList.remove('selected');
  }
  renderSelectedPanel();
});
grid.appendChild(localItem);
```

Then the existing `profiles.forEach(...)` loop continues unchanged after this block.

Also in `filterProfiles()` (line 100-106): the local browser card will naturally re-render
since `renderProfiles(filtered)` is called, which is correct -- the local option always appears.

**In public/css/style.css:**

Add at the end of the file:
```css
/* Local Browser profile card */
.profile-item.local-browser {
  border-left: 3px solid #58a6ff;
}
.profile-item.local-browser .id {
  color: #58a6ff;
}
```

**In .env.example:**

Add at the end:
```
# (Optional) Custom Chrome/Chromium path -- auto-detected if not set
# CHROME_PATH=/path/to/chrome
```
  </action>
  <verify>
    <automated>grep -q "local-browser" public/js/app.js && grep -q "local-browser" public/css/style.css && grep -q "CHROME_PATH" .env.example && echo "OK"</automated>
  </verify>
  <done>Dashboard shows a "Local Browser" card at the top of the profile grid with blue accent. Selecting it adds 'local-browser' to selectedProfileIds. .env.example documents CHROME_PATH.</done>
</task>

</tasks>

<verification>
1. `node -e "import('./src/local-launcher.js').then(m => console.log(Object.keys(m)))"` -- exports launchLocalBrowser, closeLocalBrowser
2. `grep -n 'local-browser' src/campaign.js` -- shows routing guards in profile name cache, STEP 1, and STEP 6
3. `grep -n 'closeLocalBrowser' server.js` -- shows import and shutdown call
4. Open dashboard in browser, confirm "Local Browser" card appears at top of profile grid with blue accent
5. Select "Local Browser" + start campaign -- should launch system Chrome, navigate to LinkedIn, run campaign loop
</verification>

<success_criteria>
- src/local-launcher.js exports launchLocalBrowser() returning {browser, page} and closeLocalBrowser()
- campaign.js detects 'local-browser' profileId and routes to local launcher (launch + close)
- server.js graceful shutdown also closes local browser
- Dashboard shows "Local Browser" as selectable profile option
- No changes to campaign loop, LinkedIn actions, or outreach flow
- GoLogin profiles continue to work exactly as before
</success_criteria>
