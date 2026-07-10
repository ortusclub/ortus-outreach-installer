# Primary-config Manifest + Cloud Run-Target + Handshake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three approved wizard/board features — (1) collapse the four-panel primary-person area into one "Manifest" (2 fields + plain-English readback + Customize drawer), (2) move "Running in cloud" to two tabs (💻 This machine / ☁︎ Cloud VM) above Section 1 that reshape the wizard, and (3) the app half of the cloud primary-handshake hard-lock.

**Architecture:** Follow the repo's existing seam — pure logic in browser-and-node-importable `public/js/*.mjs` (frontend) or `src/*.js` (backend), each with a `node --test` unit test; DOM wiring in `public/js/app.js` (a `<script type="module">`) verified against the approved sketches via CDP/screenshot. Features 1→2→3 in order; each phase is independently shippable (commit + optionally merge after each). No config-key or payload changes — the primary/cloud config keys already flow to the local runner and the cloud engine unchanged; these features are a new face on the existing flags plus one additive backend poller.

**Tech Stack:** vanilla ES modules (no bundler), Express 4, Node ≥22, `node --test` (assert/strict), puppeteer-core/GoLogin (reused as-is), CDP over `--remote-debugging-port` for UI verification.

## Global Constraints

- Node ≥22; vanilla JS + Express 4; **no bundler**; test runner is `node --test tests/*.test.js`.
- **OFF-LIMITS — never modify:** `src/linkedin/outreach.js`, `src/linkedin/actions.js`. (Feature 3 reuses `src/linkedin/accept-invitation.js`, `src/primary-task-runner.js`, `src/primary-tasks.js`, `src/local-launcher.js` **as-is** — read only, do not edit.)
- **Pixel truth = the approved sketches.** Match them 1:1 with the real CSS/components: F1 `public/sketches/2026-07-10-primary-config-overhaul-DE.html` (variant **D**, incl. the loud solid Customize pill + nudge line); F2 `public/sketches/2026-07-10-run-target-FGH.html` (variant **F**); F3 `public/sketches/2026-07-10-cloud-primary-handshake-lock.html` (**A+B hybrid** = inline `hs-panel` + one-time modal).
- **Payloads byte-identical** for unchanged choices. Preserve every element ID that `startCampaign` / `gatherCampaignFormState` / `applyPresetConfig` read (enumerated per task). The launch/queue/schedule/draft POST bodies must not change shape.
- Design system: monochrome, hairlines, radius 0 or 9999, gold only on the Start CTA (and the F1 Customize pill / F-VM handshake status edge, which the sketches already establish); reuse `intro-config-*`, `notif-pref-toggle/slider`, `route-seg`, `mode-card`, `snm-`/`hs-` classes.
- **Version bump before every relaunch:** patch-bump `package.json` `version` **and** both `?v=` cache-bust strings in `public/index.html` (the `/css/style.css?v=` at ~line 10 and the `/js/app.js?v=` at ~line 3266). Relaunch `npm run dev:app` in the background after any commit touching runtime code (pattern in CLAUDE.md operator rule 2).
- **Never** `git add data/monitoring-campaign.json` (tracked foot-gun).

## Before You Begin

1. **Commit policy — GET OPERATOR GO-AHEAD FIRST.** The branch `preflight-linter-2135` carries an uncommitted pile (v2.146.1→v2.154.0 cloud-parity work + today's sketches/specs). Ask the operator to either commit that pile as a checkpoint or confirm you should proceed; keep every commit in this plan **separable** from that pile (scoped `git add` of only the files each task lists — never `git add -A`). Do not push.
2. **Frontend has no DOM test harness.** UI tasks are verified by: (a) `node --test` on the extracted `.mjs` helper, and (b) CDP/screenshot against the named sketch. To CDP-verify: relaunch with a debug port, drive the real Electron renderer (see `reference_electron_renderer_cdp_debug` memory), compare to the sketch at `http://localhost:7847/sketches/<file>`.
3. **The `.mjs` + test seam:** a browser pure-helper goes in `public/js/<name>.mjs` with `export function …`, is imported at the top of `app.js` (`import { … } from '/js/<name>.mjs'`), and is unit-tested by `tests/<name>.test.js` importing the same file by relative path. Backend helpers go in `src/<name>.js` (mirror `src/cloud-soo-reconcile.js`).
4. Confirm baseline green: `node --test tests/*.test.js` (expect ~1236 pass, 0 fail).

---

# PHASE 1 — The Manifest (Feature 1)

**Spec:** `docs/superpowers/specs/2026-07-10-primary-config-overhaul-design.md`
**Sketch:** `…/2026-07-10-primary-config-overhaul-DE.html` variant **D**

**What stays identical:** every control keeps its existing ID so `startCampaign` (app.js:5438-5450, 5525, 5533, 5538), `gatherCampaignFormState` (752-808), `bulkCheckNow` (14926-14932), `devPreviewIntroDM`, and `applyPresetConfig` (10686-10736) keep reading/writing the same nodes. The Manifest is a **re-layout + a display-only readback + a collapsible drawer** around the same inputs.

**IDs that MUST survive (do not rename):** `primary-person-name`, `primary-person-url`, `primary-person-url-error`, `primary-intro-body`, `primary-source` (radio group), `primary-source-profile-id`, `primary-source-picker`, `primary-source-search`, `primary-source-grid`, `primary-source-soo-reload`, `primary-source-soo-status`, `primary-timing-select`, `auto-accept-toggle`, `auto-accept-gate`, `auto-accept-primary-line`, `auto-accept-primary-label`, `auto-accept-all-toggle`, `auto-accept-all-row`, `auto-accept-all-hint`, `check-cadence-select`, `auto-checks-toggle`, `follow-up-toggle`, `follow-up-fields`, `follow-up-delay`, `follow-up-primary-label`. Container ids `primary-person-block`, `auto-accept-block`, `check-cadence-block`, `follow-up-block`, `primary-timing-field`, `primary-source-field`, `intro-config-row`, `intro-config-col-left`, `intro-config-col-right` are referenced by `onModeChange` (2374-2483) — see Task 1.4.

### Task 1.1: Readback builder (`manifest-readback.mjs`) + tests

**Files:**
- Create: `public/js/manifest-readback.mjs`
- Test: `tests/manifest-readback.test.js`

**Interfaces:**
- Produces: `buildManifestReadback(s) → { lines: Array<{key,on,html}>, state:'standard'|'customized', cloudNotice: string|null }`. Consumed by app.js Task 1.3. Pure — no DOM.
- `s` fields: `{ mode, primaryName, primarySource, autoAcceptPrimary, autoAcceptAllPending, primaryCheckTiming, checkCadenceMinutes, autoChecksEnabled, followUpEnabled, followUpDelayMinutes, runTarget }` (`runTarget` = `'local'|'cloud'`, default `'local'` — Phase 2 supplies the real value).

- [ ] **Step 1: Write the failing test**

```js
// tests/manifest-readback.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifestReadback } from '../public/js/manifest-readback.mjs';

const BASE = {
  mode: 'connect_and_introduce', primaryName: 'Antonio Varlese',
  primarySource: 'local-browser', autoAcceptPrimary: true, autoAcceptAllPending: false,
  primaryCheckTiming: 'after_connections', checkCadenceMinutes: 60, autoChecksEnabled: true,
  followUpEnabled: true, followUpDelayMinutes: 10, runTarget: 'local',
};

test('standard CC+IC renders three ✓ lines and STANDARD state', () => {
  const r = buildManifestReadback(BASE);
  assert.equal(r.state, 'standard');
  assert.equal(r.lines.length, 3);
  assert.ok(r.lines.every((l) => l.on));
  assert.match(r.lines[0].html, /Antonio Varlese/);
  assert.match(r.lines[0].html, /local browser/i);
  assert.equal(r.cloudNotice, null);
});

test('follow-up off → third line off with "No automated follow-up"', () => {
  const r = buildManifestReadback({ ...BASE, followUpEnabled: false });
  assert.equal(r.state, 'customized');
  const fu = r.lines.find((l) => l.key === 'followup');
  assert.equal(fu.on, false);
  assert.match(fu.html, /No automated follow-up/i);
});

test('accept-all on → appended to line 1 + customized', () => {
  const r = buildManifestReadback({ ...BASE, autoAcceptAllPending: true });
  assert.equal(r.state, 'customized');
  assert.match(r.lines[0].html, /all other pending/i);
});

test('cloud + local primary → follow-up replaced by handshake line + cloudNotice set', () => {
  const r = buildManifestReadback({ ...BASE, runTarget: 'cloud' });
  const fu = r.lines.find((l) => l.key === 'followup');
  assert.equal(fu.on, false);
  assert.match(fu.html, /Your Mac accepts once/i);
  assert.ok(r.cloudNotice && /follow-up is off/i.test(r.cloudNotice));
});

test('cloud + GoLogin primary → no handshake downgrade, follow-up stays', () => {
  const r = buildManifestReadback({ ...BASE, runTarget: 'cloud', primarySource: 'gl_abc123' });
  const fu = r.lines.find((l) => l.key === 'followup');
  assert.equal(fu.on, true);
  assert.match(fu.html, /follow-up/i);
  assert.equal(r.cloudNotice, null);
});

test('introduce_back → identity only, zero readback lines', () => {
  const r = buildManifestReadback({ ...BASE, mode: 'introduce_back' });
  assert.equal(r.lines.length, 0);
});

test('connect_and_message → cadence line only, no accept/follow-up', () => {
  const r = buildManifestReadback({ ...BASE, mode: 'connect_and_message' });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].key, 'cadence');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test tests/manifest-readback.test.js`
Expected: FAIL — `Cannot find module '../public/js/manifest-readback.mjs'`.

- [ ] **Step 3: Implement `public/js/manifest-readback.mjs`**

```js
// Pure readback builder for the Primary "Manifest" panel. Turns the live
// primary/auto-accept/cadence/follow-up settings into plain-English ✓/— lines +
// a STANDARD/CUSTOMIZED flag + an optional cloud-handshake notice. No DOM.
//
// Modes: connect_and_introduce (full: accept + cadence + follow-up),
// connect_and_message (cadence only), introduce_back (identity only → no lines).

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CADENCE_LABEL = {
  60: 'every 1 hour', 120: 'every 2 hours', 240: 'every 4 hours',
  360: 'every 6 hours', 720: 'every 12 hours',
};
const DELAY_LABEL = {
  10: '10 minutes', 20: '20 minutes', 30: '30 minutes',
  45: '45 minutes', 60: '1 hour', 120: '2 hours',
};

function actorLabel(primarySource, primaryName) {
  if (primarySource && primarySource !== 'local-browser') return 'a GoLogin profile';
  const first = String(primaryName || '').trim().split(/\s+/)[0];
  return first ? `${esc(first)}'s local browser` : 'your local browser';
}

// The default profile every operator sees on a fresh CC+IC wizard. Deviations
// flip STANDARD → CUSTOMIZED. Mirrors the HTML defaults.
const STANDARD = {
  autoAcceptPrimary: true, autoAcceptAllPending: false, primarySource: 'local-browser',
  primaryCheckTiming: 'after_connections', checkCadenceMinutes: 60,
  autoChecksEnabled: true, followUpEnabled: true, followUpDelayMinutes: 10,
};

export function buildManifestReadback(s = {}) {
  const mode = s.mode || 'connect_and_introduce';
  const isCCIC = mode === 'connect_and_introduce';
  const isCCDM = mode === 'connect_and_message';
  const localPrimary = !s.primarySource || s.primarySource === 'local-browser';
  const cloudLocalPrimary = s.runTarget === 'cloud' && localPrimary;
  const actor = actorLabel(s.primarySource, s.primaryName);
  const nm = esc(s.primaryName || '(unnamed)');
  const lines = [];

  if (isCCIC) {
    // Line 1 — auto-accept
    const timing = s.primaryCheckTiming === 'immediately' ? 'Immediately at start' : 'After connections complete';
    const allPending = s.autoAcceptAllPending
      ? ' <span class="tok">+ all other pending invites ⚠️</span>' : '';
    lines.push({
      key: 'accept', on: !!s.autoAcceptPrimary,
      html: s.autoAcceptPrimary
        ? `<b>${timing}</b>, each sender requests <b>${nm}</b> — <b>${actor}</b> accepts automatically${allPending}`
        : `Auto-accept off — connect the senders to ${nm} manually before intros`,
    });
  }
  if (isCCIC || isCCDM) {
    // Cadence line
    const cad = CADENCE_LABEL[s.checkCadenceMinutes] || `every ${esc(s.checkCadenceMinutes)} min`;
    lines.push({
      key: 'cadence', on: s.autoChecksEnabled !== false,
      html: s.autoChecksEnabled !== false
        ? `Acceptances checked <b>${cad}</b>; intros fire as they land`
        : `Automatic checks off — run them with <b>⚡ Check now</b>`,
    });
  }
  if (isCCIC) {
    // Follow-up line — replaced by the handshake line when cloud + local primary.
    if (cloudLocalPrimary) {
      lines.push({
        key: 'followup', on: false,
        html: `☁︎ <b>Your Mac accepts once</b> (locked first step), then everything runs on the VM — follow-up off for this run`,
      });
    } else {
      const delay = DELAY_LABEL[s.followUpDelayMinutes] || `${esc(s.followUpDelayMinutes)} min`;
      lines.push({
        key: 'followup', on: !!s.followUpEnabled,
        html: s.followUpEnabled
          ? `First follow-up <b>${delay}</b> after the last intro`
          : `No automated follow-up`,
      });
    }
  }

  // STANDARD only when CC+IC, local run, and every knob at default.
  let state = 'standard';
  if (!isCCIC || s.runTarget === 'cloud') {
    state = 'customized';
  } else {
    for (const k of Object.keys(STANDARD)) {
      if (s[k] !== undefined && s[k] !== STANDARD[k]) { state = 'customized'; break; }
    }
  }

  const cloudNotice = cloudLocalPrimary
    ? `Running in the cloud: your Mac accepts the senders' invites once (locked first step), then everything runs on the VM. The follow-up needs the local browser, so it's off for this run.`
    : null;

  return { lines, state, cloudNotice };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test tests/manifest-readback.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/manifest-readback.mjs tests/manifest-readback.test.js
git commit -m "feat(manifest): pure readback builder for primary-config panel"
```

### Task 1.2: Replace the four-panel markup with the Manifest panel

**Files:**
- Modify: `public/index.html:799-961` (the `#intro-config-row` block)

**Interfaces:**
- Consumes: the D-variant markup from `public/sketches/2026-07-10-primary-config-overhaul-DE.html` (the `.ov-panel.ovD` block, its readback `#d-lines`, the loud `.auto-edit` Customize pill + `.auto-nudge`, and the Customize drawer `.cust` rows).
- Produces: DOM containing every ID listed above, plus new ids `primary-manifest` (panel), `manifest-readback` (lines container), `manifest-state` (STANDARD/CUSTOMIZED word), `manifest-customize-btn`, `manifest-drawer`, `manifest-cloud-notice` (hidden slot).

- [ ] **Step 1: Port the panel.** Replace `#intro-config-row` (799-961) with the Manifest structure from sketch D, mapping the drawer's compact rows to the **real controls with their existing IDs** (do NOT create new inputs for controls that already exist):
  - Identity zone: `#primary-person-name`, `#primary-person-url` (+ `#primary-person-url-error`), and — kept for CC+IC — `#primary-intro-body` stays in Section 5 as today (not moved).
  - Readback: `<div id="manifest-readback"></div>` + eyebrow `WHAT HAPPENS AUTOMATICALLY — <b id="manifest-state">STANDARD</b>` + the loud solid `<button id="manifest-customize-btn" class="auto-edit">` (icon + "Customize") + `.auto-nudge` line.
  - Drawer `<div id="manifest-drawer" class="cust" hidden>` holding the REAL controls moved verbatim (same IDs/handlers): `#auto-accept-toggle` + `#auto-accept-gate`, `#auto-accept-all-toggle` + `#auto-accept-all-row`/`#auto-accept-all-hint`, the `primary-source` radio-cards + `#primary-source-picker` (search/grid/soo-reload/status/`#primary-source-profile-id`), `#primary-timing-select`, `#check-cadence-select`, `#auto-checks-toggle`, `#follow-up-toggle` + `#follow-up-fields` (`#follow-up-delay`, `#follow-up-primary-label`).
  - Cloud slot: `<div id="manifest-cloud-notice" class="pc-cloud" hidden></div>` (styled per sketch `.pc-cloud`/`.ov-cloud`).
  - Keep `#auto-accept-primary-line`/`#auto-accept-primary-label` inside the auto-accept drawer row (still updated by `refreshPrimarySourceLabels`).
- [ ] **Step 2: Add the D-variant styles** (`.auto-edit` solid pill + `.auto-nudge` + `.cust` drawer rows + `manifest-cloud-notice`) into `public/css/style.css` under a `/* ── Primary Manifest ── */` banner, copied from the sketch's `<style>` (the `.ovD .auto-*`, `.ovD .cust`, `.ov-cloud` rules), renamespaced to `.manifest-*` where they collide. Reuse existing `intro-config-*` / `notif-pref-toggle` / `aa-src-*` classes unchanged.
- [ ] **Step 3: Bump version** — patch-bump `package.json` and both `?v=` strings in `index.html`.
- [ ] **Step 4: Manual/CDP verify** the panel renders and every drawer control is present with its original ID. Load the wizard (CC+IC mode), open Customize, confirm the drawer shows all controls; compare to sketch D.

Run: relaunch `npm run dev:app`; CDP-check `document.getElementById('auto-accept-toggle')` etc. all exist and `#manifest-drawer` toggles.
Expected: all listed IDs resolve; drawer opens/closes; no console errors.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/css/style.css package.json
git commit -m "feat(manifest): one-panel primary config markup (drawer holds real controls)"
```

### Task 1.3: Wire the readback render + Customize drawer in `app.js`

**Files:**
- Modify: `public/js/app.js` — add `import { buildManifestReadback } from '/js/manifest-readback.mjs';` (top, ~line 31); add `renderManifest()`; call it from `savePrimaryPersonFields` (11808), `refreshAutoAcceptGate` (11867), `toggleFollowUpFields` (11850), `togglePrimarySource` (11892), `onModeChange` (2374), and after `applyPresetConfig` (10715-ish).

**Interfaces:**
- Consumes: `buildManifestReadback` (Task 1.1). Reads live DOM values.
- Produces: `renderManifest()` (global, idempotent). `getManifestRunTarget()` stub returning `'local'` (Phase 2 replaces its body).

- [ ] **Step 1: Add `getManifestRunTarget()` stub + `renderManifest()`**

```js
// Phase 2 replaces the body to read the run-target tabs. Until then, local.
function getManifestRunTarget() {
  return (document.getElementById('cloud-run-checkbox')?.checked) ? 'cloud' : 'local';
}

function renderManifest() {
  const box = document.getElementById('manifest-readback');
  if (!box) return;
  const mode = document.getElementById('campaign-mode')?.value || '';
  const r = buildManifestReadback({
    mode,
    primaryName: document.getElementById('primary-person-name')?.value || '',
    primarySource: (typeof readPrimarySource === 'function') ? readPrimarySource() : 'local-browser',
    autoAcceptPrimary: !!document.getElementById('auto-accept-toggle')?.checked,
    autoAcceptAllPending: !!document.getElementById('auto-accept-all-toggle')?.checked,
    primaryCheckTiming: document.getElementById('primary-timing-select')?.value || 'immediately',
    checkCadenceMinutes: Number(document.getElementById('check-cadence-select')?.value) || 60,
    autoChecksEnabled: document.getElementById('auto-checks-toggle')?.checked !== false,
    followUpEnabled: !!document.getElementById('follow-up-toggle')?.checked,
    followUpDelayMinutes: Number(document.getElementById('follow-up-delay')?.value) || 10,
    runTarget: getManifestRunTarget(),
  });
  box.innerHTML = r.lines.map((l) =>
    `<div class="al ${l.on ? '' : 'off'}"><span class="tick">${l.on ? '✓' : '—'}</span><span>${l.html}</span></div>`
  ).join('');
  const stateEl = document.getElementById('manifest-state');
  if (stateEl) stateEl.textContent = r.state === 'standard' ? 'STANDARD' : 'CUSTOMIZED';
  const notice = document.getElementById('manifest-cloud-notice');
  if (notice) { notice.hidden = !r.cloudNotice; if (r.cloudNotice) notice.innerHTML = `☁︎ <span>${r.cloudNotice}</span>`; }
}
if (typeof window !== 'undefined') window.renderManifest = renderManifest;
```

- [ ] **Step 2: Wire the Customize toggle** (mirror the sketch's `dEditLabel`): the `#manifest-customize-btn` onclick toggles `#manifest-drawer` `hidden` and swaps its label `Customize ⇄ ✕ Done`. Add near `renderManifest`.
- [ ] **Step 3: Call `renderManifest()`** at the end of `savePrimaryPersonFields`, `refreshAutoAcceptGate`, `toggleFollowUpFields`, `togglePrimarySource`, and once inside `onModeChange` (after the block-visibility toggles), and after `applyPresetConfig` restores fields (add `if (typeof renderManifest === 'function') renderManifest();` after line 10716's `refreshAutoAcceptGate()` call).
- [ ] **Step 4: Fix the `primaryCheckTiming` round-trip gap** (research finding): in `applyPresetConfig` after line 10731, add `setV('primary-timing-select', t.primaryCheckTiming || 'immediately');` so re-run/duplicate restores the timing the Manifest now surfaces. (Deliberate fix, not silent.)
- [ ] **Step 5: Verify payloads unchanged** — start-payload reads are by ID (5438-5450, 5525/5533/5538) and untouched. Run the server-side contract tests:

Run: `node --test tests/normalize-templates-primary.test.js tests/campaign-modes.test.js tests/cadence-policy.test.js`
Expected: PASS (unchanged — the payload contract is intact).

- [ ] **Step 6: CDP verify against sketch D** — CC+IC: 2 fields + 3 ✓ lines + STANDARD; toggle follow-up off in the drawer → line flips to "— No automated follow-up" + CUSTOMIZED; switch mode to introduce_back → identity only; connect_and_message → cadence line only.
- [ ] **Step 7: Commit**

```bash
git add public/js/app.js
git commit -m "feat(manifest): live readback + Customize drawer wiring"
```

### Task 1.4: Mode-aware Manifest visibility in `onModeChange`

**Files:**
- Modify: `public/js/app.js:2374-2483` (`onModeChange`).

- [ ] **Step 1: Update the block toggles.** The four `style.display` toggles (2393-2447) now target the single `#primary-manifest` panel plus its zones. Replace them so: `#primary-manifest` shows for CC+IC | ICB | CC+DM (any mode that had any sub-block); the identity zone shows for CC+IC | ICB; the readback+drawer's accept/follow-up rows show only for CC+IC; the cadence row shows for CC+IC | CC+DM; `#primary-timing-field`/`#primary-source-field` stay CC+IC-only (2432/2434 unchanged, they're inside the drawer now). Keep the existing `refreshAutoAcceptGate()` (2404) and `toggleFollowUpFields()` (2409) calls and ADD `renderManifest()` after them.
- [ ] **Step 2: CDP verify** each of the four modes shows the correct Manifest subset (matrix in the F1 research: CC+IC full, ICB identity-only, CC+DM cadence-only, others hidden).
- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "feat(manifest): mode-aware panel/zone visibility"
```

---

# PHASE 2 — Command Tabs (Feature 2)

**Spec:** `docs/superpowers/specs/2026-07-10-run-target-tabs-design.md`
**Sketch:** `…/2026-07-10-run-target-FGH.html` variant **F**

**DECISION — default tab:** today's `#cloud-run-checkbox` ships `checked` (cloud-default-ON, per app.js:5638 comment). To keep behavior byte-identical, the tabs **default to ☁︎ Cloud VM**. (My F2 spec mis-stated "This machine"; the plan corrects it to match production. The operator may want to flip the default to This-machine — it's a one-line constant `DEFAULT_RUN_TARGET`; surface this in the handoff, do not silently choose.)

**Source of truth:** keep the hidden `#cloud-run-checkbox` input — the tabs write its `.checked`, and `startCampaign`'s cloud gate (app.js:5643 `_cloudOn`) reads it unchanged. The visible Launch checkbox row (index.html ~2412-2416) is **removed**.

### Task 2.1: Run-target helpers (`run-target.mjs`) + tests

**Files:**
- Create: `public/js/run-target.mjs`
- Test: `tests/run-target.test.js`

**Interfaces:**
- Produces: `CLOUD_MODES` (Set), `isCloudMode(mode)`, `modeAvailability(mode, runTarget, { engineConfigured }) → { available:boolean, reason:string }`, `runTargetFacts(runTarget) → Array<{ok:boolean, text:string}>`, `DEFAULT_RUN_TARGET` (`'cloud'`).

- [ ] **Step 1: Write the failing test**

```js
// tests/run-target.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCloudMode, modeAvailability, runTargetFacts, DEFAULT_RUN_TARGET, CLOUD_MODES } from '../public/js/run-target.mjs';

test('CLOUD_MODES matches the app’s engine-supported set', () => {
  for (const m of ['connect_only','message_only','introduce_back','connect_and_introduce','connect_and_message','follower_growth','inmail_only','open_profile_only','check_status']) {
    assert.ok(CLOUD_MODES.has(m), `${m} should be cloud-capable`);
  }
  assert.equal(isCloudMode('check_dms'), false);
  assert.equal(isCloudMode('post_amplification'), false);
});

test('local run → every mode available', () => {
  assert.deepEqual(modeAvailability('check_dms', 'local', { engineConfigured: true }), { available: true, reason: '' });
});

test('cloud run → non-cloud mode unavailable with reason', () => {
  const r = modeAvailability('check_dms', 'cloud', { engineConfigured: true });
  assert.equal(r.available, false);
  assert.match(r.reason, /local/i);
});

test('cloud run + cloud mode → available', () => {
  assert.equal(modeAvailability('connect_and_introduce', 'cloud', { engineConfigured: true }).available, true);
});

test('DEFAULT_RUN_TARGET is cloud (matches production checkbox default)', () => {
  assert.equal(DEFAULT_RUN_TARGET, 'cloud');
});

test('facts differ per target and name the key trade-offs', () => {
  const vm = runTargetFacts('cloud').map((f) => f.text).join(' ');
  assert.match(vm, /close the laptop|survives/i);
  assert.match(vm, /GoLogin/);
  assert.match(vm, /follow-up/i);
  const local = runTargetFacts('local').map((f) => f.text).join(' ');
  assert.match(local, /pause|resume/i);
});
```

- [ ] **Step 2: Run, verify fail** — `node --test tests/run-target.test.js` → module-not-found.
- [ ] **Step 3: Implement `public/js/run-target.mjs`**

```js
// Browser-safe run-target logic shared by the wizard tabs. Mirrors the
// engine-supported mode set used at launch (app.js startCampaign _cloudModeNow /
// refreshCloudToggle). Kept here as the single browser source of truth.
export const CLOUD_MODES = new Set([
  'connect_only', 'message_only', 'introduce_back', 'connect_and_introduce',
  'connect_and_message', 'follower_growth', 'inmail_only', 'open_profile_only', 'check_status',
]);
export const DEFAULT_RUN_TARGET = 'cloud'; // production checkbox ships `checked`

export function isCloudMode(mode) { return CLOUD_MODES.has(String(mode || '')); }

export function modeAvailability(mode, runTarget, { engineConfigured = true } = {}) {
  if (runTarget !== 'cloud') return { available: true, reason: '' };
  if (!engineConfigured) return { available: false, reason: 'Cloud engine not configured' };
  if (!isCloudMode(mode)) return { available: false, reason: 'This mode is local-only — switch to 💻 This machine' };
  return { available: true, reason: '' };
}

export function runTargetFacts(runTarget) {
  if (runTarget === 'cloud') {
    return [
      { ok: true,  text: 'Survives closing the laptop' },
      { ok: true,  text: 'Watch it live with 👁 Show on the board' },
      { ok: false, text: 'Stop only — no pause/resume' },
      { ok: false, text: '~2-3 min warm-up' },
      { ok: false, text: 'Senders must be GoLogin accounts' },
      { ok: false, text: 'No automated follow-up (local primary)' },
    ];
  }
  return [
    { ok: true,  text: 'Full control — pause, resume, edit mid-run' },
    { ok: true,  text: 'Every mode available' },
    { ok: false, text: 'Stops if the app closes or the Mac sleeps' },
  ];
}
```

- [ ] **Step 4: Run, verify pass** — `node --test tests/run-target.test.js` → PASS (6).
- [ ] **Step 5: Commit**

```bash
git add public/js/run-target.mjs tests/run-target.test.js
git commit -m "feat(run-target): browser-safe run-target + mode-availability helpers"
```

### Task 2.2: Tabs markup above Section 1; remove the Launch checkbox

**Files:**
- Modify: `public/index.html` — insert the tabs block above `#mode-grid`'s section (Section 1, ~line 776 area's section heading); remove the `#cloud-run-toggle` visible label row (~2412-2416) but KEEP a hidden `<input type="checkbox" id="cloud-run-checkbox" checked hidden>` as the source of truth.

- [ ] **Step 1: Add the tabs** (port sketch F `.rt-tabs` + `.rt-facts`), reusing `route-seg`-family styling for the segmented control, two-line labels per sketch:

```html
<!-- Where it runs — the first decision; writes #cloud-run-checkbox (hidden source of truth) -->
<div id="run-target" class="run-target" data-target="cloud">
  <div class="rt-tabs" role="tablist" aria-label="Where the campaign runs">
    <button type="button" class="rt-tab" data-rt="local" role="tab" onclick="setRunTarget('local')">
      <span class="t">💻 This machine</span><span class="s">Runs while the app is open — pause &amp; resume anytime</span>
    </button>
    <button type="button" class="rt-tab on" data-rt="cloud" role="tab" onclick="setRunTarget('cloud')">
      <span class="t">☁︎ Cloud VM</span><span class="s">Keeps going after you close the laptop</span>
    </button>
  </div>
  <div class="rt-facts" id="run-target-facts"></div>
</div>
```

- [ ] **Step 2: Move the hidden checkbox.** Replace the visible `#cloud-run-toggle` label (2412-2416) with `<input type="checkbox" id="cloud-run-checkbox" checked hidden onchange="refreshCloudToggle()">` (keep the id + `checked` default + onchange so `startCampaign`/`refreshCloudToggle` are unaffected). Leave `#cloud-fg-extras` where it is (still shown by `refreshCloudToggle`).
- [ ] **Step 3: Styles** — copy sketch F's `.rt-tabs/.rt-tab/.rt-facts/.rt-fact` rules into `style.css` (or the index inline block) under `/* ── Run target ── */`.
- [ ] **Step 4: Version bump.** Patch-bump `package.json` + both `?v=`.
- [ ] **Step 5: Commit**

```bash
git add public/index.html public/css/style.css package.json
git commit -m "feat(run-target): local/VM tabs above Campaign Type; retire launch checkbox"
```

### Task 2.3: Tab wiring + downstream reactions in `app.js`

**Files:**
- Modify: `public/js/app.js` — import from `/js/run-target.mjs`; add `setRunTarget()` / `getRunTarget()` / `refreshRunTarget()`; replace `getManifestRunTarget()` body (Task 1.3) to read the tabs; hook `renderModeSelector` (4061) for local-only badges; hook the launch note + Queue/Schedule visibility; call from `onModeChange` + init.

**Interfaces:**
- Consumes: `run-target.mjs` exports.
- Produces: `getRunTarget() → 'local'|'cloud'`, `setRunTarget(t)`, `refreshRunTarget()`.

- [ ] **Step 1: Add the imports + state functions**

```js
import { CLOUD_MODES as RT_CLOUD_MODES, modeAvailability, runTargetFacts, DEFAULT_RUN_TARGET } from '/js/run-target.mjs';
// … later, near refreshCloudToggle:
function getRunTarget() {
  return document.getElementById('run-target')?.dataset.target || DEFAULT_RUN_TARGET;
}
function setRunTarget(t) {
  const root = document.getElementById('run-target');
  if (!root) return;
  root.dataset.target = t;
  root.querySelectorAll('.rt-tab').forEach((b) => b.classList.toggle('on', b.dataset.rt === t));
  const cb = document.getElementById('cloud-run-checkbox');
  if (cb) cb.checked = (t === 'cloud');   // keep the launch source-of-truth in sync
  refreshRunTarget();
}
function refreshRunTarget() {
  const t = getRunTarget();
  const facts = document.getElementById('run-target-facts');
  if (facts) facts.innerHTML = runTargetFacts(t).map((f) =>
    `<span class="rt-fact"><span class="i">${f.ok ? '✓' : '—'}</span><span>${escHtml(f.text)}</span></span>`).join('');
  if (typeof renderModeSelector === 'function') renderModeSelector();
  if (typeof renderManifest === 'function') renderManifest();
  refreshLaunchForRunTarget();
  if (typeof refreshAccountPickerForRunTarget === 'function') refreshAccountPickerForRunTarget();
}
if (typeof window !== 'undefined') { window.setRunTarget = setRunTarget; window.getRunTarget = getRunTarget; }
```

- [ ] **Step 2: Replace `getManifestRunTarget()`** (added in Task 1.3) body with `return getRunTarget();`.
- [ ] **Step 3: Local-only badges in the mode grid.** In `renderModeSelector` (4099-4122), compute `const avail = modeAvailability(m.value, getRunTarget(), { engineConfigured: <see Task 2.5> });` and when `!avail.available` render the card with the greyed `is-coming-soon`-style class + a `💻 LOCAL ONLY` badge, and make `setModeByIndex` (4125) show a toast (`avail.reason`) instead of selecting. Do NOT auto-change the current selection (spec: block, don't silently switch).
- [ ] **Step 4: Launch note + Queue/Schedule.** Add `refreshLaunchForRunTarget()`: when `getRunTarget()==='cloud'`, hide `#btn-queue` and `#btn-schedule` (they are local-only — `launchQueueIt`→`addToQueueCampaign`, `launchScheduleIt`→`/api/schedules`, neither dispatches cloud, confirmed app.js:17157/17261) and set a note under the launch buttons to the VM copy ("Starts on the VM — close the laptop whenever. Watch it with 👁 Show."); when `'local'`, show them + local copy. Use a new `<div id="launch-run-note">` added to the launch card in Task 2.2's index edit (add it there).
- [ ] **Step 5: Call from init + onModeChange.** In `onModeChange` add `if (typeof refreshRunTarget === 'function') refreshRunTarget();` (after the existing `refreshCloudToggle()` call). On DOMContentLoaded init, call `setRunTarget(DEFAULT_RUN_TARGET)` once after the wizard renders.
- [ ] **Step 6: CDP verify against sketch F** — flip tabs: facts row swaps; Check DMs greys with 💻 LOCAL ONLY under VM; Manifest follow-up line → handshake line under VM+local-primary; Queue/Schedule hidden + note changes under VM. Confirm `#cloud-run-checkbox.checked` tracks the tab.
- [ ] **Step 7: Verify launch payload** — with VM tab active + CC+IC, the start POST still routes cloud exactly as before (checkbox checked). Local tab → local start. No shape change.

Run: `node --test tests/*.test.js`
Expected: full suite PASS (no server contract touched).

- [ ] **Step 8: Commit**

```bash
git add public/js/app.js public/index.html
git commit -m "feat(run-target): tab wiring + mode-grid/manifest/launch reactions"
```

### Task 2.4: Hide local-only sender accounts under VM

**Files:**
- Modify: `public/js/app.js` — the account picker render (find via `grep -n "renderAccountPicker\|account-grid\|selectedProfileIds\|local-browser" public/js/app.js`; the sender list where a `'local-browser'` pseudo-account can appear).

- [ ] **Step 1:** Add `refreshAccountPickerForRunTarget()` that, when `getRunTarget()==='cloud'`, hides/disables any sender entry whose profileId is `'local-browser'` (or lacks a GoLogin id) with a `💻 local only` tag, and re-includes them under `'local'`. Call it from `refreshRunTarget` (already wired in Task 2.3 Step 1). Locate the exact picker render function first and mirror its item markup.
- [ ] **Step 2: CDP verify** a local-browser sender is absent/flagged when VM is active, present when local.
- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "feat(run-target): exclude local-only sender accounts from cloud runs"
```

### Task 2.5: Disable the VM tab when the engine isn't configured

**Files:**
- Modify: `public/js/app.js`; add a tiny server probe or reuse an existing one.

- [ ] **Step 1:** Determine engine-configured client-side. The server knows (`isCampaignEngineConfigured()` in `src/campaigns-client.js`). Add a one-liner to an existing bootstrap endpoint response (or check `grep -n "engineConfigured\|SCRAPER_ENGINE_URL\|scraper-engine" public/js/app.js server.js` for an already-exposed flag). Pass `engineConfigured` into `modeAvailability` and, when false, add `disabled` + tooltip "Cloud engine not configured" to the `☁︎ Cloud VM` `.rt-tab`, force `setRunTarget('local')`, and skip cloud dispatch.
- [ ] **Step 2: Verify** — with the engine env unset the VM tab is disabled and the wizard defaults to local; with it set, VM is enabled.
- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "feat(run-target): disable VM tab when cloud engine unconfigured"
```

---

# PHASE 3 — Cloud primary-handshake hard-lock (app half)

**Spec:** `docs/superpowers/specs/2026-07-10-cloud-primary-handshake-design.md`
**Engine contract (reference, not built here):** `docs/cloud-engine-primary-handshake-spec.md`
**Sketch:** `…/2026-07-10-cloud-primary-handshake-lock.html` (A inline + B modal)

**REUSE-ONLY (never edit):** `src/primary-task-runner.js`, `src/primary-tasks.js`, `src/linkedin/accept-invitation.js`, `src/local-launcher.js`. **Structure template (don't edit):** `src/cloud-soo-reconcile.js`, `src/cloud-sheet-reconcile.js`.

**Graceful degradation:** until the engine ships `state:'awaiting_primary_accept'`, `getCloudCampaign(id)` never returns it, so every new code path is inert — the strip renders normally and nothing polls/accepts. Mirror the `openCampaignViewStream` 501 pattern.

### Task 3.1: `signalPrimaryAcceptDone` client + server proxy

**Files:**
- Modify: `src/campaigns-client.js` (after line 175, next to `getCloudCampaignLeads`).
- Modify: `server.js` (add proxy next to the `cloud/:id/stop` route ~1508-1512).
- Test: `tests/campaigns-client-handshake.test.js`

**Interfaces:**
- Produces: `signalPrimaryAcceptDone(id, acceptedIds) → parsed | { error, status }` (single-attempt POST via `requestOnce`, mirroring `startCloudCampaign`).

- [ ] **Step 1: Failing test** (mirror the module's error-shape contract; stub `fetch` via the engine-not-configured branch which needs no network):

```js
// tests/campaigns-client-handshake.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalPrimaryAcceptDone } from '../src/campaigns-client.js';

test('unconfigured engine → structured error, never throws', async () => {
  const saved = process.env.SCRAPER_ENGINE_URL;
  delete process.env.SCRAPER_ENGINE_URL;
  // scraper-engine-url.js may hardcode a default; assert the shape not the branch.
  const r = await signalPrimaryAcceptDone('cmp_x', ['gl_a']);
  assert.ok(r && (r.error !== undefined || r.ok !== undefined));
  if (saved) process.env.SCRAPER_ENGINE_URL = saved;
});
```

- [ ] **Step 2: Run, verify fail** — export missing.
- [ ] **Step 3: Implement in `src/campaigns-client.js`** (after `getCloudCampaignLeads`, line 175):

```js
/**
 * Signal the engine that the local primary browser has accepted the campaign's
 * pending sender invitations (cloud primary-handshake, local-only primary).
 * Single attempt (mirrors startCloudCampaign) — a duplicate returns a terminal
 * 409 that requestOnce encodes as { error, status:409 }. See
 * docs/cloud-engine-primary-handshake-spec.md.
 * @param {string}   id           cloud campaign id
 * @param {string[]} acceptedIds  sender profileIds accepted
 */
export function signalPrimaryAcceptDone(id, acceptedIds) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/primary-accept-done`, {
    accepted: Array.isArray(acceptedIds) ? acceptedIds : [],
  });
}
```

- [ ] **Step 4: Server proxy** — in `server.js` next to the `cloud/:id/stop` route (~1508), add:

```js
// Cloud primary-handshake: the local app POSTs which senders its local primary
// browser accepted; forwarded to the engine which re-verifies + resumes.
app.post('/api/campaign/cloud/:id/primary-accept-done', async (req, res) => {
  const ids = Array.isArray(req.body?.accepted) ? req.body.accepted : [];
  const r = await signalPrimaryAcceptDone(req.params.id, ids);
  if (r.error) return res.status(r.status || 502).json(r);
  res.json(r);
});
```

Add `signalPrimaryAcceptDone` to the `campaigns-client.js` import in server.js (the line importing `getCloudCampaignLeads, openCampaignViewStream`).

- [ ] **Step 5: Run tests, verify pass** — `node --test tests/campaigns-client-handshake.test.js`.
- [ ] **Step 6: Commit**

```bash
git add src/campaigns-client.js server.js tests/campaigns-client-handshake.test.js
git commit -m "feat(handshake): signalPrimaryAcceptDone client + server proxy"
```

### Task 3.2: Handshake mapping + once-only store (`src/cloud-primary-handshake.js`) + tests

**Files:**
- Create: `src/cloud-primary-handshake.js` (mirror `src/cloud-soo-reconcile.js`'s tmp+rename store + pure mapping).
- Test: `tests/cloud-primary-handshake.test.js` (mirror `tests/cloud-sheet-reconcile.test.js` table shape).

**Interfaces:**
- Produces (pure): `sendersToAcceptTasks(detail, campaignCtx) → Array<{account:{name,profileUrl}, profileId}>` (maps engine `senders[]` → the `{name, profileUrl}` shape `pickInvitation`/`buildAcceptTask` consume, skipping `accepted:true`); `computeAcceptedIds(detail, results) → string[]`; `isAwaitingAccept(detail) → boolean`.
- Produces (stateful, tmp+rename to `data/cloud-primary-handshake.json`): `hasSignaled(id)`, `markSignaled(id)`, `hasShownModal(id)`, `markShownModal(id)` — once-only guards so the 4s poll doesn't re-fire the accept/modal.

- [ ] **Step 1: Failing test**

```js
// tests/cloud-primary-handshake.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAwaitingAccept, sendersToAcceptTasks, computeAcceptedIds } from '../src/cloud-primary-handshake.js';

const DETAIL = {
  campaign: { id: 'cmp_1', state: 'awaiting_primary_accept', mode: 'connect_and_introduce',
    primary: { name: 'Antonio Varlese', url: 'https://www.linkedin.com/in/antoniovarlese/' },
    senders: [
      { profileId: 'gl_a', name: 'Alex Sheeraz', url: 'https://linkedin.com/in/alex', accepted: false },
      { profileId: 'gl_b', name: 'Marco Rossi',  url: 'https://linkedin.com/in/marco', accepted: true },
    ],
    acceptAllPending: false } };

test('isAwaitingAccept true only for the awaiting state', () => {
  assert.equal(isAwaitingAccept(DETAIL), true);
  assert.equal(isAwaitingAccept({ campaign: { state: 'running' } }), false);
  assert.equal(isAwaitingAccept({}), false);
});

test('sendersToAcceptTasks maps unaccepted senders to pickInvitation shape', () => {
  const tasks = sendersToAcceptTasks(DETAIL);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].account, { name: 'Alex Sheeraz', profileUrl: 'https://linkedin.com/in/alex' });
  assert.equal(tasks[0].profileId, 'gl_a');
});

test('computeAcceptedIds returns ids whose accept succeeded', () => {
  const ids = computeAcceptedIds(DETAIL, [{ profileId: 'gl_a', accepted: true }, { profileId: 'gl_c', accepted: false }]);
  assert.deepEqual(ids, ['gl_a']);
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `src/cloud-primary-handshake.js` — pure functions above + the tmp+rename store copied structurally from `cloud-soo-reconcile.js` (`load()`/`persist()` with `dataPath('cloud-primary-handshake.json')`, `{ campaigns: { [id]: { signaled:bool, modalShown:bool } } }`, `MAX_CAMPAIGNS` prune). `isAwaitingAccept(d)` = `((d&&d.campaign)||{}).state === 'awaiting_primary_accept'`. `sendersToAcceptTasks(d)` maps `campaign.senders.filter(s=>!s.accepted)` → `{ account:{ name:s.name, profileUrl:s.url }, profileId:s.profileId }`.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit**

```bash
git add src/cloud-primary-handshake.js tests/cloud-primary-handshake.test.js
git commit -m "feat(handshake): sender→accept-task mapping + once-only store"
```

### Task 3.3: Server-side handshake reconciler (poll → local accept → signal)

**Files:**
- Modify: `server.js` — add `reconcilePrimaryHandshake(id, detail)` next to `reconcileCloud` (~1356), invoked fire-and-forget after the `cloud/:id` response (route ~1337) for owner+local-primary cloud campaigns.

**Interfaces:**
- Consumes: `isAwaitingAccept`, `sendersToAcceptTasks`, `computeAcceptedIds`, `hasSignaled/markSignaled` (Task 3.2); `buildAcceptTask`/`enqueuePrimaryTask` (`src/primary-tasks.js`); `runDueTasks`+`tick` deps (`src/primary-task-runner.js`); `launchLocalBrowser`/`closeLocalBrowser` (`src/local-launcher.js`); `acceptInvitationFrom`/`acceptAllPendingInvitations` (`src/linkedin/accept-invitation.js`); `signalPrimaryAcceptDone`.

- [ ] **Step 1:** Implement `reconcilePrimaryHandshake(id, detail)` mirroring `reconcileCloud`'s throttle+guard shape:
  - Guard: `if (!isAwaitingAccept(detail)) return;` and `if (await hasSignaled(id)) return;` and only for `detail.campaign` where `autoAcceptPrimary && primarySource==='local-browser'` (from `detail.campaign.config`).
  - **Idle gate:** reuse the existing `shouldRun({ campaignRunning, browserCount })` discipline — only drive the local browser when no local campaign is running and the browser semaphore is free (same as `primary-task-runner`). If busy, return (next poll retries).
  - Enqueue one accept task per `sendersToAcceptTasks(detail)` entry via `buildAcceptTask({ …, account, primaryUrl: detail.campaign.primary.url, sender:'local-browser' })` + `enqueuePrimaryTask`, then drive the existing `runDueTasks(Date.now(), deps)`/`tick` (reusing its real wiring — `launchLocal: launchLocalBrowser`, `acceptInvitationFrom`, semaphore). If `detail.campaign.acceptAllPending`, the deps already call `acceptAllPendingInvitations` per the runner's design (verify; if not, run it once against the opened local page after the targeted accepts).
  - Collect per-sender results → `computeAcceptedIds` → `await signalPrimaryAcceptDone(id, acceptedIds)` → on non-error `await markSignaled(id)`.
  - Wrap everything in try/catch; log via the existing logger; never throw into the request path.
- [ ] **Step 2:** Invoke it after the `cloud/:id` response — in the `app.get('/api/campaign/cloud/:id')` handler (~1337), after `res.json(r)`, add `reconcilePrimaryHandshake(req.params.id, r).catch(() => {});` (fire-and-forget, mirrors `reconcileCloud` on `/leads`). **Owner gate:** only when the campaign's `owner === getOperatorEmail()` (this machine launched it) — the accept drives THIS Mac's local browser.
- [ ] **Step 3:** No new unit test for the orchestration (it drives real browsers — integration only). Confirm the pure pieces (Task 3.2) are green and that the server boots: `node --check server.js`.
- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(handshake): server reconciler — poll, drive local accept, signal engine"
```

### Task 3.4: Inline lock panel on the running cloud strip (sketch A)

**Files:**
- Modify: `public/js/app.js` — carry `state`/`senders`/`primary`/`acceptAllPending` onto the strip item (renderCampaignsBoard push ~6796-6804) and render the `hs-panel` in `renderUnifiedStrip` (running-cloud branch ~6450 + body ~6480) when `it.state==='awaiting_primary_accept'`.
- Modify: `public/index.html` — add the `hs-panel` CSS (copy from the lock sketch).

- [ ] **Step 1:** In `renderCampaignsBoard` where the cloud item is pushed (~6796), add `state: (d&&d.campaign||c).state, senders: (d&&d.campaign||c).senders, primary: (d&&d.campaign||c).primary, acceptAllPending: (d&&d.campaign||c).acceptAllPending` to the item.
- [ ] **Step 2:** In `renderUnifiedStrip`, when `it.state==='awaiting_primary_accept'`, replace the log/switch block with the inline `hs-panel` markup from sketch A (eyebrow "Phase 0 · Primary handshake — locked", progress `accepted/total` from `it.senders`, per-sender `.hs-row.done/.doing/waiting`, the accept-all line when `it.acceptAllPending`, the "keep the app open" line), and set the foot to `Skip & continue` + `Cancel` + Open (per sketch). When state leaves awaiting, render the normal running strip (unchanged).
- [ ] **Step 3:** Copy the `.hs-panel/.hs-row/.hs-done/.hs-*` CSS from `…-cloud-primary-handshake-lock.html` into `style.css` under `/* ── Handshake lock ── */`.
- [ ] **Step 4: Version bump** + relaunch.
- [ ] **Step 5: CDP verify** — simulate a strip item with `state:'awaiting_primary_accept'` + 5 senders (2 accepted) via the renderer and confirm it matches sketch A; leaving the state flips to the normal green running strip.
- [ ] **Step 6: Commit**

```bash
git add public/js/app.js public/index.html public/css/style.css package.json
git commit -m "feat(handshake): inline lock panel on running cloud strip"
```

### Task 3.5: One-time handshake modal (sketch B)

**Files:**
- Modify: `public/index.html` — add `#hs-scrim`/`.hs-modal` markup mirroring `#snm-scrim` (~3361) + its CSS (~1467).
- Modify: `public/js/app.js` — open it once per campaign when the lock first appears (mirror `snm-scrim` open/close at ~509-532); track shown-ids in an in-memory `Set` (client) plus the server `hasShownModal` guard is not needed client-side — the client Set suffices per session.

- [ ] **Step 1:** Add `#hs-scrim` markup + CSS (mirror snm, styled per sketch B: progress ring `2/5`, sender checklist, accept-all note, "keep this window open", Skip / Cancel buttons).
- [ ] **Step 2:** In `renderCampaignsBoard`/`renderUnifiedStrip`, when a campaign transitions into `awaiting_primary_accept` and its id isn't in `_hsModalShown` (a module `Set`), populate + open `#hs-scrim` and `_hsModalShown.add(id)`. Dismiss on Skip/Cancel/backdrop (buttons are display-only stand-ins here — the accept is driven server-side; Skip closes the modal, the inline panel remains).
- [ ] **Step 3: CDP verify** the modal fires once when the lock first appears and not on subsequent 4s polls.
- [ ] **Step 4: Commit**

```bash
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(handshake): one-time modal when the lock first engages"
```

### Task 3.6: Full-suite gate + graceful-degradation check

- [ ] **Step 1:** `node --test tests/*.test.js` — full suite green (new: `manifest-readback`, `run-target`, `campaigns-client-handshake`, `cloud-primary-handshake`).
- [ ] **Step 2:** With the real engine (which does NOT yet return `awaiting_primary_accept`), CDP-confirm a running cloud CC+IC strip renders normally (no lock, no errors, no phantom local-accept) — the whole Phase-3 path is inert until the engine ships its half.
- [ ] **Step 3:** Update memory `project_ortus_cloud_parity` with the handshake app-half status (built, engine-half pending) — one line.
- [ ] **Step 4: Commit** (docs/memory only).

---

## Self-Review

**Spec coverage:**
- F1 spec §Design zones (identity/readback/Customize) → Tasks 1.1–1.3; mode-aware visibility (CC+IC/ICB/CC+DM) → 1.4; URL-gate kept → drawer keeps `#auto-accept-gate`+`refreshAutoAcceptGate` (1.2/1.3); cloud-notice slot → 1.2 + driven 1.3/2.3; payloads unchanged → IDs preserved (1.2) + contract tests (1.3 Step 5). ✅
- F2 spec tabs+facts → 2.1/2.2/2.3; mode-grid local-only → 2.3 Step 3; Manifest reaction → 2.3 Step 2; accounts picker → 2.4; launch buttons/note → 2.3 Step 4; engine-unconfigured → 2.5; persistence parity (checkbox source of truth) → 2.2 Step 2; default corrected to cloud → 2.1 `DEFAULT_RUN_TARGET`. ✅
- F3 spec poll→accept→signal → 3.2/3.3; targeted + accept-all → 3.3; A+B UI → 3.4/3.5; graceful degradation → 3.6 Step 2; owner-gate → 3.3 Step 2; engine half is a handoff doc (not built) → stated. ✅

**Placeholder scan:** the two "locate the exact function first" steps (2.4 account picker, 2.5 engine-configured flag) are genuine discovery — each names the `grep` to run and the exact change to make; not TODO placeholders. All code steps carry full code.

**Type consistency:** `getRunTarget`/`setRunTarget`/`refreshRunTarget`, `renderManifest`, `buildManifestReadback`, `modeAvailability`/`runTargetFacts`, `sendersToAcceptTasks`/`computeAcceptedIds`/`isAwaitingAccept`, `signalPrimaryAcceptDone` — names consistent across all references. `#cloud-run-checkbox` is the single launch source of truth throughout. `runTarget` values are `'local'|'cloud'` everywhere.

**Open decision surfaced (not silently chosen):** default run-target = cloud (matches production); flagged for operator in the handoff.
