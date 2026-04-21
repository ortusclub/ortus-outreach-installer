---
phase: 260421-pae
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/campaign.js
  - server.js
  - public/index.html
  - public/js/app.js
  - public/css/style.css
autonomous: true
requirements:
  - QUICK-260421-PAE

must_haves:
  truths:
    - "User sees a 'Preview Messages' button inside the Message Templates section"
    - "Clicking Preview Messages calls POST /api/templates/preview with the same form state that /api/campaign/start expects"
    - "Server picks the first 3 rows from the selected sheet whose LinkedIn URL is extractable via extractLinkedInUrl() and returns rendered templates for each"
    - "Each preview card shows the lead's name + company + URL and every non-empty rendered template with a live character count"
    - "Character count turns red when it exceeds field-specific limits (300 for connection note, 200 for InMail subject, 1900 for InMail body)"
    - "Warnings are shown for any {placeholder} that could not be resolved from the lead's data"
    - "Modal closes on backdrop click, ESC key, and close button"
    - "Preview button is disabled (with explanatory title) when no sheet URL is entered OR all 6 template fields are empty"
    - "If sheet fetch fails, the modal shows a readable error instead of silently failing"
  artifacts:
    - path: "src/campaign.js"
      provides: "Export of extractLinkedInUrl() so server.js can reuse it"
      contains: "export function extractLinkedInUrl"
    - path: "server.js"
      provides: "POST /api/templates/preview endpoint"
      contains: "/api/templates/preview"
    - path: "public/index.html"
      provides: "Preview Messages button + #preview-modal DOM"
      contains: "preview-modal"
    - path: "public/js/app.js"
      provides: "handlePreviewClick(), renderPreviewModal(), CHAR_LIMITS constants, gatherCampaignFormState() helper"
      contains: "handlePreviewClick"
    - path: "public/css/style.css"
      provides: "Styles for #preview-modal + .char-count + .char-count--over"
      contains: "preview-modal"
  key_links:
    - from: "public/js/app.js handlePreviewClick"
      to: "server.js /api/templates/preview"
      via: "fetch POST JSON body matching /api/campaign/start shape"
      pattern: "fetch.*api/templates/preview"
    - from: "server.js /api/templates/preview"
      to: "src/campaign.js extractLinkedInUrl"
      via: "named import"
      pattern: "extractLinkedInUrl"
    - from: "server.js /api/templates/preview"
      to: "src/linkedin/helpers.js personalizeTemplate"
      via: "named import"
      pattern: "personalizeTemplate"
    - from: "server.js /api/templates/preview"
      to: "src/sheets.js fetchSheet"
      via: "existing import reused"
      pattern: "fetchSheet\\("
---

<objective>
Add a "Preview Messages" feature so operators can see exactly what each template will look like after personalization BEFORE launching a campaign. On click, the server renders the current templates against the first 3 non-empty leads from the selected sheet. A modal then shows each rendered message with character counts (red when over the LinkedIn limits) and warnings for any `{placeholder}` that failed to resolve.

Purpose: Catch template bugs (missing variables, accidental typos in `{varName}`, oversized connection notes) before sending dozens of broken DMs.

Output:
- `src/campaign.js` — `extractLinkedInUrl` becomes exported (pure-function, no behavior change)
- `server.js` — new `POST /api/templates/preview` endpoint next to the existing sheet preview
- `public/index.html` — Preview button + modal skeleton
- `public/js/app.js` — preview click handler, form-state gatherer, modal renderer, character-limit constants
- `public/css/style.css` — minimal preview-modal styling reusing existing design tokens
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md

# The existing sheet-preview endpoint and campaign-start endpoint define the
# style + body shape this new endpoint must mirror.
@server.js
@src/campaign.js
@src/linkedin/helpers.js
@public/index.html
@public/js/app.js
@public/css/style.css

<interfaces>
<!-- EVERYTHING the executor needs to know about existing code, verified against the current codebase. -->

== src/campaign.js — extractLinkedInUrl (line 84) ==
CURRENT STATUS: NOT exported (plain `function extractLinkedInUrl(row, linkedinColumn)`).
REQUIRED CHANGE: Add `export` to the declaration at line 84 — pure function, no other change. Other call sites inside campaign.js (lines 329, 545, 574) continue to work because the function is still defined at module scope.

Signature:
```js
export function extractLinkedInUrl(row, linkedinColumn) => string | null
// 1. If linkedinColumn is set and row[linkedinColumn] has a value:
//    - Full URL (contains linkedin.com): normalized to https:// prefix, returned
//    - Bare slug/id (no spaces, no @): returns `https://www.linkedin.com/in/${slug}`
// 2. Otherwise scans every column value for `linkedin.com` substring and returns first match.
// 3. Returns null when nothing matches.
```

== src/campaign.js — template normalization (lines 280-289) ==
The EXACT normalization block the new endpoint must reuse (inline — do NOT extract to a helper in this task, just copy the shape so legacy keys match):
```js
const tpl = {
  connectionNote: templates.connectionNote || templates.note || '',
  followUpMessage: templates.followUpMessage || templates.followUp1 || '',
  inmail: {
    subject: templates.inmail?.subject || templates.inmailSubject || '',
    message: templates.inmail?.message || templates.inmailBody || '',
  },
  openProfileSubject: templates.openProfileSubject || templates.opSubject || '',
  openProfileBody: templates.openProfileBody || templates.opBody || '',
};
```

== src/campaign.js — data object construction (lines 603-612) ==
The EXACT shape of the `data` object passed to personalizeTemplate, per row:
```js
const data = { ...row };
data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
data.lastName  = row['Last Name']  || row['lastName']  || row['last_name']  || '';
data.company   = row['Company']    || row['company']   || '';
data.title     = row['Title']      || row['title']     || row['Job Title']  || '';
data.senderName = pName || '';  // the GoLogin profile name
const resolvedFirst = senderFirstNames[profileId];
data.senderFirstName = (resolvedFirst && resolvedFirst.trim())
  || (pName || '').split(/\s+/)[0]
  || '';
```
In THIS endpoint we don't have a live GoLogin session — use `profileIds[0]` (the first id) as the profileId key. For `pName` use `profileIds[0] || ''` as a fallback string (the client doesn't send profile names; that's fine — senderName may just render as the profile id, which is acceptable for a preview).

== src/linkedin/helpers.js — personalizeTemplate (line 365) ==
```js
export function personalizeTemplate(template, data = {}) {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  // Anything left as `{something}` gets stripped out in the final pass
  return result.replace(/\{[a-zA-Z0-9_ ]+\}/g, '').trim();
}
```
IMPORTANT: This function silently strips unresolved placeholders. That's why the warnings block must be computed BEFORE calling personalizeTemplate, by scanning the raw template with the same regex and checking which keys are missing/empty in data.

== server.js existing shape ==
Existing `/api/sheet/preview` at server.js:244 — copy its error-handling pattern (try/catch + readable JSON error).
Existing `/api/campaign/start` at server.js:264 — the new endpoint accepts the same body fields (sheetUrl, linkedinColumn, templates, profileIds, senderFirstNames). profileIds + senderFirstNames may be empty.
Existing imports at top of server.js: `fetchSheet` from `./src/sheets.js` — REUSE this (do NOT re-import). `personalizeTemplate` and `extractLinkedInUrl` must be ADDED to the imports.

== public/index.html structure ==
- Templates section: line 294-350 (`.section.template-controls` div).
- Templates header (for the button): line 298 `.templates-header` — insert the new button AFTER the `.templates-question` div, still inside `.templates-header`.
- Existing modal pattern: line 563-574 `#prompt-modal`. The new `#preview-modal` lives next to it (same level in the DOM), reuses `.prompt-modal` + `.prompt-modal__backdrop` CSS conventions but with its own id and a wider card (preview content is longer).

== public/js/app.js existing patterns ==
- `startCampaign()` at line 1122 — shows how form state is gathered. Specifically note:
  - `document.getElementById('sheet-url').value.trim()`
  - `document.getElementById('linkedin-col-select')?.value || ''`
  - `selectedProfileIds` (module-level array, always available)
  - `selectedProfileNames` (module-level map, always available)
  - Templates object shape at line 1178-1185 (mirror this: connectionNote / followUp1 / inmailSubject / inmailBody / openProfileSubject / openProfileBody — legacy keys that the server normalizes)
  - senderFirstNames via `resolveSenderFirstName(id, pName)` at line 1145
- `promptModal()` at line 68 — shows the open/close lifecycle pattern (hidden attr toggle, cleanup function, ESC handler). `renderPreviewModal` must follow this exact pattern.

== public/css/style.css tokens ==
- `--red: #f85149` (line 20) — use for over-limit counter
- `--gray`, `--bg`, `--ink`, `--hairline`, `--mono`, `--body` — reuse existing
- `.prompt-modal`, `.prompt-modal__backdrop`, `.prompt-modal__card`, `.prompt-modal__actions` at lines 1717-1760 — the preview modal reuses these with different modifier classes where needed.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="false">
  <name>Task 1: Server endpoint POST /api/templates/preview</name>
  <files>src/campaign.js, server.js</files>
  <behavior>
    - Given a valid sheetUrl and templates with at least one non-empty field, the endpoint returns `{ previews: [...] }` with up to 3 entries.
    - Each preview entry has shape: `{ lead: { firstName, lastName, company, url }, rendered: { connectionNote, followUpMessage, inmailSubject, inmailBody, opProfileSubject, opProfileBody }, warnings: string[] }`.
    - `rendered` values are empty strings for templates that were empty in the input (do NOT omit keys — keep shape consistent for the UI).
    - Warnings are computed from raw templates BEFORE personalization — each unresolved `{placeholder}` produces one warning like `"{companyName} not resolved for connectionNote"`.
    - If the sheet fetch throws (bad URL, auth, etc.), endpoint returns HTTP 200 with `{ previews: [], error: err.message }` (mirrors the `/api/sheet/preview` style so the UI can show it without parsing error status codes).
    - If fewer than 3 rows have extractable LinkedIn URLs, returns whatever it found (even if 0).
    - If ALL 6 template fields are empty, returns HTTP 400 with `{ error: 'At least one template field must be provided' }`.
  </behavior>
  <action>
Step 1 — Export `extractLinkedInUrl` in `src/campaign.js`:
- Line 84: change `function extractLinkedInUrl(row, linkedinColumn) {` to `export function extractLinkedInUrl(row, linkedinColumn) {`.
- No other change. Verify existing internal call sites at lines 329, 545, 574 still resolve (they do — function name unchanged).

Step 2 — Add imports to `server.js` (top of file, next to the existing `./src/campaign.js` import at line 18):
```js
import { startCampaign, stopCampaign, getCampaignStatus, campaign, extractLinkedInUrl } from './src/campaign.js';
import { personalizeTemplate } from './src/linkedin/helpers.js';
```
(`fetchSheet` is ALREADY imported at line 19 — don't duplicate it.)

Step 3 — Insert the endpoint in `server.js` DIRECTLY AFTER the existing `/api/sheet/preview` handler (after line 259, before the `// Campaign control` section comment at line 261):

```js
// ---------------------------------------------------------------------------
// Template preview — render current templates against the first 3 leads so
// the operator can spot missing variables / over-limit messages before launch.
// Same body shape as /api/campaign/start so the client can reuse its form-
// state gatherer. Errors are returned as 200 + { previews: [], error } so the
// UI can always render a readable message.
// ---------------------------------------------------------------------------
app.post('/api/templates/preview', async (req, res) => {
  try {
    const {
      sheetUrl,
      linkedinColumn = '',
      templates = {},
      profileIds = [],
      senderFirstNames = {},
    } = req.body || {};

    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    // Mirror campaign.js:280-289 template normalization so legacy aliases work.
    const tpl = {
      connectionNote: templates.connectionNote || templates.note || '',
      followUpMessage: templates.followUpMessage || templates.followUp1 || '',
      inmailSubject: templates.inmail?.subject || templates.inmailSubject || '',
      inmailBody: templates.inmail?.message || templates.inmailBody || '',
      opProfileSubject: templates.openProfileSubject || templates.opSubject || '',
      opProfileBody: templates.openProfileBody || templates.opBody || '',
    };

    const anyFilled = Object.values(tpl).some(v => v && v.trim());
    if (!anyFilled) {
      return res.status(400).json({ error: 'At least one template field must be provided' });
    }

    // Fetch the sheet — if this fails we return 200 + error so the UI can
    // show it without parsing error codes (mirrors the general pattern).
    let rows;
    try {
      rows = await fetchSheet(sheetUrl);
    } catch (err) {
      console.error('Templates preview — sheet fetch error:', err.message);
      return res.json({ previews: [], error: err.message });
    }

    // Pick the first 3 rows with an extractable LinkedIn URL.
    const picked = [];
    for (const row of rows) {
      if (picked.length >= 3) break;
      const url = extractLinkedInUrl(row, linkedinColumn);
      if (url) picked.push({ row, url });
    }

    const profileId = profileIds[0] || '';
    const pName = profileId; // no live GoLogin session in preview — id stands in for name

    const previews = picked.map(({ row, url }) => {
      // Mirror campaign.js:603-612 data construction.
      const data = { ...row };
      data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
      data.lastName  = row['Last Name']  || row['lastName']  || row['last_name']  || '';
      data.company   = row['Company']    || row['company']   || '';
      data.title     = row['Title']      || row['title']     || row['Job Title']  || '';
      data.senderName = pName || '';
      const resolvedFirst = senderFirstNames[profileId];
      data.senderFirstName = (resolvedFirst && resolvedFirst.trim())
        || (pName || '').split(/\s+/)[0]
        || '';

      // For each field, scan the raw template for {placeholders}, compute
      // unresolved ones, then render.
      const warnings = [];
      const rendered = {};
      const fieldLabels = {
        connectionNote: 'Connection Note',
        followUpMessage: 'Follow-up Message',
        inmailSubject: 'InMail Subject',
        inmailBody: 'InMail Body',
        opProfileSubject: 'Open Profile Subject',
        opProfileBody: 'Open Profile Body',
      };
      for (const [key, raw] of Object.entries(tpl)) {
        if (!raw) { rendered[key] = ''; continue; }
        const placeholderMatches = raw.match(/\{([a-zA-Z0-9_ ]+)\}/g) || [];
        const unresolved = placeholderMatches
          .map(m => m.slice(1, -1))
          .filter(name => {
            const val = data[name];
            return val === undefined || val === null || val === '';
          });
        for (const name of unresolved) {
          warnings.push(`{${name}} not resolved for ${fieldLabels[key]}`);
        }
        rendered[key] = personalizeTemplate(raw, data);
      }

      return {
        lead: {
          firstName: data.firstName,
          lastName: data.lastName,
          company: data.company,
          url,
        },
        rendered,
        warnings,
      };
    });

    res.json({ previews });
  } catch (err) {
    console.error('Templates preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

AVOID:
- Do NOT modify any other function in `campaign.js` (project convention: preserve core automation logic).
- Do NOT alter `personalizeTemplate` — its strip-unresolved behavior is required by other call sites; the warnings block is what surfaces misses.
- Do NOT add any new npm dependency — everything used is already imported.
- Do NOT add request-logging beyond `console.error` on failure (matches existing endpoints).
  </action>
  <verify>
    <automated>node --input-type=module -e "import('./src/campaign.js').then(m => { if (typeof m.extractLinkedInUrl !== 'function') { console.error('FAIL: extractLinkedInUrl not exported'); process.exit(1); } const u = m.extractLinkedInUrl({ LinkedIn: 'https://linkedin.com/in/foo' }, 'LinkedIn'); if (!u || !u.includes('linkedin.com')) { console.error('FAIL: extractLinkedInUrl returned', u); process.exit(1); } console.log('OK: extractLinkedInUrl exported and functional'); });"</automated>
    Also: `node -c server.js` must return no syntax errors (implicit via server.js import chain parse).
  </verify>
  <done>
    - `src/campaign.js` line 84 starts with `export function extractLinkedInUrl`.
    - `server.js` imports `extractLinkedInUrl` from `./src/campaign.js` and `personalizeTemplate` from `./src/linkedin/helpers.js`.
    - `server.js` has a new `app.post('/api/templates/preview', ...)` handler immediately after `/api/sheet/preview`.
    - Handler returns `{ previews: [...] }` shaped per the behavior block above.
    - `node -c server.js` parses cleanly and the automated verify script passes.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 2: UI button + modal DOM + click handler + renderer</name>
  <files>public/index.html, public/js/app.js, public/css/style.css</files>
  <behavior>
    - A "Preview Messages" button appears inside the Message Templates section header.
    - Button is disabled (with a `title` explaining why) when: sheet URL is empty OR all 6 template fields are empty. Otherwise enabled.
    - Clicking the button: shows a "Loading…" state on the button, POSTs the current form state to `/api/templates/preview`, opens a modal populated with the results, restores the button text.
    - Modal shows: each preview as a card (lead header + each non-empty rendered field + char count + warnings), and a single shared warnings-only message when `previews.length === 0` but no error, and a readable error message when `error` is present.
    - Character count for each rendered field turns red when the field is over its LinkedIn limit: connectionNote ≤ 300, inmailSubject ≤ 200, inmailBody ≤ 1900. Other fields have no hard limit — show count in default color.
    - Modal closes on: backdrop click, ESC key, close button. Re-clicking Preview re-fetches (no stale cache).
  </behavior>
  <action>
Step 1 — `public/index.html` button insertion (line 298 block `.templates-header`):

BEFORE (line 298-306):
```html
      <div class="templates-header">
        <div class="templates-question" id="templates-question" style="display:none">
          <span class="q-text" id="templates-q-text">Do you want to add a note while connecting?</span>
          <div class="yesno-toggle">
            <button type="button" id="add-note-yes" class="yesno-btn" onclick="setAddNote(true)">Yes</button>
            <button type="button" id="add-note-no" class="yesno-btn active" onclick="setAddNote(false)">No</button>
          </div>
        </div>
      </div>
```

AFTER (add the preview button just before the closing `</div>` of `.templates-header`):
```html
      <div class="templates-header">
        <div class="templates-question" id="templates-question" style="display:none">
          <span class="q-text" id="templates-q-text">Do you want to add a note while connecting?</span>
          <div class="yesno-toggle">
            <button type="button" id="add-note-yes" class="yesno-btn" onclick="setAddNote(true)">Yes</button>
            <button type="button" id="add-note-no" class="yesno-btn active" onclick="setAddNote(false)">No</button>
          </div>
        </div>
        <button type="button" id="btn-preview-messages" class="btn btn-secondary" onclick="handlePreviewClick()" title="Enter a sheet URL and at least one template to preview">Preview Messages</button>
      </div>
```

Step 2 — `public/index.html` modal DOM (insert immediately after the existing `#prompt-modal` block, BEFORE the closing `</div>` of `.app` or before the `<script src="/js/app.js">` tag — cleanest is right after line 574 (after `#prompt-modal`'s closing `</div>`)):

```html
  <!-- Preview Messages modal — populated by renderPreviewModal() in app.js -->
  <div id="preview-modal" class="prompt-modal preview-modal" hidden>
    <div class="prompt-modal__backdrop" id="preview-modal-backdrop"></div>
    <div class="prompt-modal__card preview-modal__card" role="dialog" aria-modal="true" aria-labelledby="preview-modal-title">
      <div class="preview-modal__header">
        <h3 id="preview-modal-title" class="preview-modal__title">Message Preview</h3>
        <button type="button" id="preview-modal-close" class="preview-modal__close" aria-label="Close">&times;</button>
      </div>
      <div id="preview-modal-body" class="preview-modal__body">
        <!-- Populated by renderPreviewModal() -->
      </div>
    </div>
  </div>
```

Step 3 — `public/js/app.js` additions. Insert all of the following near the TOP of the file (right after the `resolveSenderFirstName` function that already lives around line 8-18, or grouped with other helpers near line 98 — place somewhere that loads before `startCampaign` but after basic globals):

```js
// ─────────────────────────────────────────────────────────────────────────────
// Message Preview
// ─────────────────────────────────────────────────────────────────────────────

// LinkedIn-imposed length limits. undefined = no hard limit.
const CHAR_LIMITS = {
  connectionNote: 300,
  followUpMessage: undefined,
  inmailSubject: 200,
  inmailBody: 1900,
  opProfileSubject: undefined,
  opProfileBody: undefined,
};

// Display labels used in the modal card section headers.
const PREVIEW_FIELD_LABELS = {
  connectionNote: 'Connection Note',
  followUpMessage: 'Follow-up Message',
  inmailSubject: 'InMail Subject',
  inmailBody: 'InMail Body',
  opProfileSubject: 'Open Profile Subject',
  opProfileBody: 'Open Profile Body',
};

// Collects the same form state that startCampaign() sends to /api/campaign/start.
// Mirrors app.js:1122-1185 so the server-side normalization works identically.
function gatherCampaignFormState() {
  const sheetUrl = document.getElementById('sheet-url').value.trim();
  const linkedinColumn = document.getElementById('linkedin-col-select')?.value || '';
  const mode = document.getElementById('campaign-mode').value;
  const addNoteOn = localStorage.getItem('ortus-add-note') === '1';

  const templates = {
    connectionNote: (mode === 'connect_only' && !addNoteOn) ? '' : document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
    openProfileSubject: document.getElementById('tpl-op-subject')?.value || '',
    openProfileBody: document.getElementById('tpl-op-body')?.value || '',
  };

  const senderFirstNames = {};
  for (const id of selectedProfileIds) {
    const pName = selectedProfileNames[id] || id;
    senderFirstNames[id] = resolveSenderFirstName(id, pName);
  }

  return {
    sheetUrl,
    linkedinColumn,
    templates,
    profileIds: [...selectedProfileIds],
    senderFirstNames,
  };
}

// Returns { disabled: bool, reason: string | null } — drives the Preview button state.
function getPreviewDisabledReason() {
  const sheetUrl = document.getElementById('sheet-url')?.value?.trim() || '';
  if (!sheetUrl) return { disabled: true, reason: 'Enter a Google Sheet URL first' };
  const anyTemplate = [
    document.getElementById('tpl-note')?.value,
    document.getElementById('tpl-followup')?.value,
    document.getElementById('tpl-inmail-subject')?.value,
    document.getElementById('tpl-inmail-body')?.value,
    document.getElementById('tpl-op-subject')?.value,
    document.getElementById('tpl-op-body')?.value,
  ].some(v => v && v.trim());
  if (!anyTemplate) return { disabled: true, reason: 'Fill in at least one template to preview' };
  return { disabled: false, reason: null };
}

function refreshPreviewButtonState() {
  const btn = document.getElementById('btn-preview-messages');
  if (!btn) return;
  const { disabled, reason } = getPreviewDisabledReason();
  btn.disabled = disabled;
  btn.title = disabled ? reason : 'Render current templates against 3 sample leads';
}

async function handlePreviewClick() {
  const btn = document.getElementById('btn-preview-messages');
  const { disabled } = getPreviewDisabledReason();
  if (disabled) { refreshPreviewButtonState(); return; }

  const state = gatherCampaignFormState();
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const res = await fetch('/api/templates/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    const data = await res.json();
    if (!res.ok) {
      renderPreviewModal([], data.error || `Request failed (${res.status})`);
    } else {
      renderPreviewModal(data.previews || [], data.error || null);
    }
  } catch (err) {
    renderPreviewModal([], err.message || 'Network error');
  } finally {
    btn.textContent = originalText;
    refreshPreviewButtonState();
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderPreviewModal(previews, error) {
  const modal = document.getElementById('preview-modal');
  const body = document.getElementById('preview-modal-body');
  const closeBtn = document.getElementById('preview-modal-close');
  const backdrop = document.getElementById('preview-modal-backdrop');
  if (!modal || !body) return;

  let html = '';
  if (error) {
    html += `<div class="preview-modal__error">Error: ${escapeHtml(error)}</div>`;
  }
  if (!error && previews.length === 0) {
    html += `<div class="preview-modal__empty">No leads with LinkedIn URLs found in the sheet.</div>`;
  }

  for (const p of previews) {
    const leadName = [p.lead.firstName, p.lead.lastName].filter(Boolean).join(' ') || '(no name)';
    html += `<div class="preview-card">`;
    html += `  <div class="preview-card__lead">`;
    html += `    <strong>${escapeHtml(leadName)}</strong>`;
    if (p.lead.company) html += ` <span class="preview-card__company">— ${escapeHtml(p.lead.company)}</span>`;
    if (p.lead.url) html += ` <a href="${escapeHtml(p.lead.url)}" target="_blank" rel="noopener" class="preview-card__url">${escapeHtml(p.lead.url)}</a>`;
    html += `  </div>`;

    for (const key of Object.keys(PREVIEW_FIELD_LABELS)) {
      const text = p.rendered?.[key];
      if (!text) continue;
      const limit = CHAR_LIMITS[key];
      const len = text.length;
      const over = limit !== undefined && len > limit;
      const countLabel = limit !== undefined ? `${len} / ${limit} chars` : `${len} chars`;
      html += `<div class="preview-card__field">`;
      html += `  <div class="preview-card__field-header">`;
      html += `    <span class="preview-card__field-name">${escapeHtml(PREVIEW_FIELD_LABELS[key])}</span>`;
      html += `    <span class="preview-card__count ${over ? 'preview-card__count--over' : ''}">${escapeHtml(countLabel)}</span>`;
      html += `  </div>`;
      html += `  <pre class="preview-card__text">${escapeHtml(text)}</pre>`;
      html += `</div>`;
    }

    if (p.warnings && p.warnings.length) {
      html += `<div class="preview-card__warnings">`;
      html += `  <div class="preview-card__warnings-title">Warnings</div>`;
      html += `  <ul>${p.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
      html += `</div>`;
    }
    html += `</div>`; // .preview-card
  }

  body.innerHTML = html;
  modal.hidden = false;

  const onClose = () => {
    modal.hidden = true;
    closeBtn.removeEventListener('click', onClose);
    backdrop.removeEventListener('click', onClose);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
  closeBtn.addEventListener('click', onClose);
  backdrop.addEventListener('click', onClose);
  document.addEventListener('keydown', onKey);
}

// Keep the Preview button state in sync as the user types / changes selections.
document.addEventListener('DOMContentLoaded', () => {
  refreshPreviewButtonState();
  const watchIds = [
    'sheet-url',
    'tpl-note', 'tpl-followup',
    'tpl-inmail-subject', 'tpl-inmail-body',
    'tpl-op-subject', 'tpl-op-body',
  ];
  for (const id of watchIds) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', refreshPreviewButtonState);
  }
});
```

Step 4 — `public/css/style.css` additions (append to END of file — these reuse the existing `.prompt-modal` / `.prompt-modal__backdrop` classes already applied on the same element, and just add preview-specific overrides):

```css
/* ─────────────────────────────────────────────────────────────────────────
   Preview Messages modal — reuses .prompt-modal layout, widens card + adds
   scrollable body, card-per-lead layout, char-count color states.
   ───────────────────────────────────────────────────────────────────────── */
.preview-modal__card {
  width: min(720px, calc(100vw - 48px));
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  padding: 0;
}
.preview-modal__header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--hairline);
}
.preview-modal__title {
  margin: 0;
  font-family: var(--mono);
  font-size: 0.8rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink);
}
.preview-modal__close {
  background: transparent; border: none; color: var(--gray);
  font-size: 1.4rem; line-height: 1; cursor: pointer;
  padding: 4px 8px;
}
.preview-modal__close:hover { color: var(--ink); }
.preview-modal__body {
  overflow-y: auto;
  padding: 16px 24px 24px;
}
.preview-modal__error {
  padding: 12px; margin-bottom: 12px;
  border: 1px solid var(--red); color: var(--red);
  font-size: 0.85rem;
}
.preview-modal__empty {
  padding: 24px 0; color: var(--gray);
  font-size: 0.9rem; text-align: center;
}
.preview-card {
  padding: 16px 0;
  border-bottom: 1px solid var(--hairline);
}
.preview-card:last-child { border-bottom: none; }
.preview-card__lead { margin-bottom: 12px; font-size: 0.9rem; }
.preview-card__company { color: var(--gray); }
.preview-card__url {
  display: block; margin-top: 4px;
  color: var(--gray); font-size: 0.75rem; text-decoration: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.preview-card__url:hover { color: var(--ink); text-decoration: underline; }
.preview-card__field { margin-top: 10px; }
.preview-card__field-header {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 4px;
}
.preview-card__field-name {
  font-family: var(--mono); font-size: 0.65rem;
  letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--gray);
}
.preview-card__count {
  font-family: var(--mono); font-size: 0.7rem; color: var(--gray);
}
.preview-card__count--over { color: var(--red); font-weight: 600; }
.preview-card__text {
  margin: 0; padding: 8px 10px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--hairline);
  font-family: var(--body); font-size: 0.85rem;
  white-space: pre-wrap; word-break: break-word;
}
.preview-card__warnings {
  margin-top: 10px; padding: 8px 10px;
  border-left: 2px solid var(--red);
  background: rgba(248, 81, 73, 0.06);
}
.preview-card__warnings-title {
  font-family: var(--mono); font-size: 0.65rem;
  letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--red); margin-bottom: 4px;
}
.preview-card__warnings ul { margin: 0; padding-left: 18px; font-size: 0.8rem; color: var(--ink); }
```

AVOID:
- Do NOT call `window.prompt` / `window.confirm` inside the new flow — use the custom modal only.
- Do NOT duplicate `fetchSheet` / `personalizeTemplate` logic on the client — always go through the server endpoint.
- Do NOT re-implement `resolveSenderFirstName` — it already exists at app.js:8.
- Do NOT change the existing templates object shape used by startCampaign (`followUp1`, `inmailSubject`, `inmailBody`, `openProfileSubject`, `openProfileBody`). Preview uses the same shape so the server normalization is identical.
- Do NOT create a new CSS file — append to `public/css/style.css`.
  </action>
  <verify>
    <automated>node --check public/js/app.js && grep -q "id=\"btn-preview-messages\"" public/index.html && grep -q "id=\"preview-modal\"" public/index.html && grep -q "handlePreviewClick" public/js/app.js && grep -q "gatherCampaignFormState" public/js/app.js && grep -q "CHAR_LIMITS" public/js/app.js && grep -q "preview-card__count--over" public/css/style.css && echo "OK: UI wiring present"</automated>
    Manual-adjacent smoke test (non-blocking, for executor sanity): `node server.js` then POST `curl -X POST http://localhost:3000/api/templates/preview -H 'Content-Type: application/json' -d '{"sheetUrl":"<a-real-sheet-url>","templates":{"connectionNote":"Hi {firstName}!"}}'` — expect `{ previews: [...] }` or `{ previews: [], error: ... }`.
  </verify>
  <done>
    - Preview button exists inside `.templates-header` and calls `handlePreviewClick()`.
    - Button is disabled with an explanatory title when preconditions aren't met; enabled otherwise.
    - `#preview-modal` exists in DOM with header/body/close-button structure.
    - Clicking the button fetches `/api/templates/preview`, populates the modal, and restores the button label.
    - Modal closes on backdrop click, close button click, and ESC key.
    - Character counts shown per field; connection note > 300, InMail subject > 200, InMail body > 1900 render in red (`.preview-card__count--over`).
    - `node --check public/js/app.js` passes and the automated grep verify line succeeds.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Human verification — preview flow works end-to-end with a real sheet</name>
  <what-built>
    A working Preview Messages button and modal. On click, the server renders the operator's current templates against the first 3 leads from the selected Google Sheet, the modal displays each personalized message with character counts, and any unresolved `{placeholder}` produces a warning.
  </what-built>
  <how-to-verify>
    1. Start the app (`npm run dev` or the usual entry point).
    2. Open the UI. In the sidebar/campaign panel:
       - Paste a real Google Sheet URL that contains at least one LinkedIn column and 3+ lead rows.
       - Select any LinkedIn column in the dropdown.
       - Fill in at least one template — e.g. Connection Note: `Hi {firstName} at {company}! From {senderFirstName}.`
       - Optionally fill InMail subject/body with a deliberately oversized string (> 200 / > 1900 chars) to test the red counter.
       - Optionally include a made-up placeholder like `{nonexistentField}` to test the warnings block.
    3. Click **Preview Messages**. Expected:
       - Button shows "Loading…" briefly, then the modal opens.
       - Modal title: "Message Preview".
       - 1–3 preview cards appear. Each card shows: lead name + company + clickable LinkedIn URL, each non-empty rendered template with its character count, and a Warnings block if anything was unresolved.
       - Oversized fields show their count in red.
       - `{firstName}` / `{company}` / `{senderFirstName}` are correctly replaced with lead/profile values.
       - Unknown placeholders (`{nonexistentField}`) appear in the Warnings list (and are stripped from the rendered text — that's the existing personalizeTemplate behavior).
    4. Close the modal via (a) the × button, (b) backdrop click, (c) ESC key — all three should close it.
    5. Clear the sheet URL → Preview button becomes disabled and its tooltip reads "Enter a Google Sheet URL first".
    6. Refill the sheet URL but clear all 6 template fields → button disabled, tooltip reads "Fill in at least one template to preview".
    7. Enter a junk sheet URL (e.g. `https://example.invalid/`) and click Preview → modal opens showing a readable error message (not a stack trace).
    8. Confirm existing campaign flow still works: fill a valid preset, click Start Campaign — campaign still starts normally (no regression from the new imports or button).
  </how-to-verify>
  <resume-signal>Type "approved" if all 8 steps behave as described, or describe what broke so the executor can fix it before the task is considered done.</resume-signal>
</task>

</tasks>

<verification>
- `src/campaign.js` exposes `extractLinkedInUrl` as a named export; existing internal usages still work.
- `server.js` responds to `POST /api/templates/preview` with `{ previews: [...] }` for valid input, `{ previews: [], error }` for sheet-fetch failures, and `400 { error }` for empty templates / missing sheetUrl.
- `public/index.html` contains `#btn-preview-messages` and `#preview-modal` in the correct locations.
- `public/js/app.js` defines `CHAR_LIMITS`, `PREVIEW_FIELD_LABELS`, `gatherCampaignFormState`, `getPreviewDisabledReason`, `refreshPreviewButtonState`, `handlePreviewClick`, `escapeHtml`, `renderPreviewModal`, and a DOMContentLoaded listener that wires up the input-change handlers.
- `public/css/style.css` has the `.preview-modal__*` and `.preview-card__*` rules, including `.preview-card__count--over` using `var(--red)`.
- No existing function in `campaign.js`, `outreach.js`, or `helpers.js` is modified beyond adding `export` to `extractLinkedInUrl`.
- Campaign start flow still works unchanged (Task 3 step 8).
</verification>

<success_criteria>
- Operator can click Preview Messages and see 3 personalized messages per sheet without launching a campaign.
- Oversized messages are visible at a glance (red count).
- Unresolved template variables are explicitly flagged (Warnings block) instead of silently disappearing.
- Button gates appropriately (no sheet URL OR no templates → disabled with tooltip reason).
- All close interactions work (backdrop / button / ESC).
- Error states (bad URL, backend error) render a readable message instead of crashing.
- Zero regressions to Start Campaign or any existing preview/sheet endpoint.
</success_criteria>

<output>
After completion, create `.planning/quick/260421-pae-add-preview-messages-button-click-to-ren/260421-pae-SUMMARY.md` following the standard GSD summary template (@$HOME/.claude/get-shit-done/templates/summary.md).
</output>
