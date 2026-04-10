---
phase: quick
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/campaign.js
  - src/linkedin/helpers.js
  - public/index.html
  - public/js/app.js
autonomous: true
requirements: [DYN-TPL-01]
must_haves:
  truths:
    - "Any column header from the Google Sheet can be used as a {placeholder} in message templates"
    - "Legacy templates using {firstName}, {lastName}, {company}, {title} still work unchanged"
    - "Placeholder tags shown in the UI update dynamically when a sheet is previewed"
    - "Unused placeholders (including multi-word column names) are cleaned from sent messages"
  artifacts:
    - path: "src/campaign.js"
      provides: "Dynamic data object spreading all row columns"
      contains: "...row"
    - path: "src/linkedin/helpers.js"
      provides: "Updated cleanup regex for multi-word placeholders"
      contains: "[a-zA-Z0-9_ ]+"
    - path: "public/index.html"
      provides: "Empty placeholder-tags containers (no hardcoded spans)"
    - path: "public/js/app.js"
      provides: "updatePlaceholderTags function populated from sheet columns"
      contains: "updatePlaceholderTags"
  key_links:
    - from: "public/js/app.js"
      to: "public/index.html"
      via: "querySelectorAll('.placeholder-tags') populates containers"
      pattern: "querySelectorAll.*placeholder-tags"
    - from: "src/campaign.js"
      to: "src/linkedin/helpers.js"
      via: "personalizeTemplate receives spread row data"
      pattern: "personalizeTemplate"
---

<objective>
Make every Google Sheet column header available as a {placeholder} in message templates, replacing the current hardcoded 4-field limitation.

Purpose: Operators need to personalize outreach with arbitrary sheet data (event names, cities, custom fields) without code changes.
Output: Dynamic placeholder support in backend data construction, regex cleanup, and frontend tag generation.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/campaign.js (lines 360-380 — hardcoded data object)
@src/linkedin/helpers.js (lines 209-216 — personalizeTemplate function)
@public/index.html (lines 92-127 — three placeholder-tags divs)
@public/js/app.js (lines 173-199 — previewSheet function; lines 630-658 — init + tag click handler)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Backend — spread all row columns + fix cleanup regex</name>
  <files>src/campaign.js, src/linkedin/helpers.js</files>
  <action>
In src/campaign.js at line 365, replace the hardcoded data object with a dynamic spread:

```javascript
// Spread all sheet columns as template variables
const data = { ...row };
// Add normalized aliases for backwards compatibility
data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
data.lastName = row['Last Name'] || row['lastName'] || row['last_name'] || '';
data.company = row['Company'] || row['company'] || '';
data.title = row['Title'] || row['title'] || row['Job Title'] || '';
```

This preserves all existing behavior (the 4 normalized aliases) while adding every column from the sheet row.

In src/linkedin/helpers.js line 215, update the cleanup regex from:
```javascript
return result.replace(/\{[a-zA-Z]+\}/g, '').trim();
```
to:
```javascript
return result.replace(/\{[a-zA-Z0-9_ ]+\}/g, '').trim();
```
This ensures unused multi-word column headers like {Event City} or {event_date} get stripped from the final message.

CRITICAL: Do NOT modify any other lines in campaign.js. Do NOT touch the campaign loop, mode logic, or LinkedIn action flow.
  </action>
  <verify>
    <automated>grep -n "\.\.\.row" src/campaign.js && grep -n "a-zA-Z0-9_" src/linkedin/helpers.js</automated>
  </verify>
  <done>campaign.js spreads all row keys into data object with backwards-compatible aliases. helpers.js regex handles multi-word/underscore/numeric placeholder names.</done>
</task>

<task type="auto">
  <name>Task 2: Frontend — dynamic placeholder tags from sheet columns</name>
  <files>public/index.html, public/js/app.js</files>
  <action>
In public/index.html, replace the three hardcoded placeholder-tags sections. Remove all child span elements but keep the container divs with their data-target attributes:

Line 95-100 (tpl-note section): Replace with just:
```html
<div class="placeholder-tags" data-target="tpl-note"></div>
```

Line 107-112 (tpl-followup section): Replace with just:
```html
<div class="placeholder-tags" data-target="tpl-followup"></div>
```

Line 122-126 (tpl-inmail-body section): Replace with just:
```html
<div class="placeholder-tags" data-target="tpl-inmail-body"></div>
```

In public/js/app.js, add the sheetColumns state and updatePlaceholderTags function. At the top of the file (after the existing variable declarations on line 6), add:

```javascript
// Dynamic placeholder tags from sheet columns
let sheetColumns = ['firstName', 'lastName', 'company', 'title'];
```

Add the updatePlaceholderTags function before the previewSheet function (around line 172):

```javascript
function updatePlaceholderTags() {
  document.querySelectorAll('.placeholder-tags').forEach(container => {
    container.innerHTML = sheetColumns.map(col =>
      `<span class="tag" data-val="{${col}}">{${col}}</span>`
    ).join('');
  });
}
```

Inside previewSheet(), after the successful response (after line 183 where data.columns is used), add:
```javascript
sheetColumns = data.columns;
updatePlaceholderTags();
```

In the Init section (around line 630), add a call to populate default tags on page load:
```javascript
updatePlaceholderTags();
```

The existing click handler (lines 642-658) already works generically via data-target and data-val — no changes needed there.
  </action>
  <verify>
    <automated>grep -c "placeholder-tags" public/index.html | grep "3" && grep -n "updatePlaceholderTags" public/js/app.js && grep -n "sheetColumns" public/js/app.js</automated>
  </verify>
  <done>Placeholder tag containers are empty in HTML. Tags populate dynamically: defaults (firstName, lastName, company, title) on page load, then actual sheet column names after Preview Sheet is clicked. Existing tag click-to-insert behavior works unchanged.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Sheet data -> template | Untrusted sheet column names/values enter template strings |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-quick-01 | S (Spoofing) | personalizeTemplate | accept | Template replacement is server-side only, no auth boundary crossed |
| T-quick-02 | T (Tampering) | data spread from row | accept | Row data already trusted from Google Sheets API; spread does not introduce new attack surface |
| T-quick-03 | I (Info Disclosure) | placeholder tags in UI | accept | Column names are already visible in sheet preview table; showing as tags adds no new exposure |
</threat_model>

<verification>
1. Start the app, load a Google Sheet with custom columns (e.g., "Event Name", "City", "Custom Field")
2. Click Preview Sheet — verify the placeholder tags update to show all column headers
3. Click a custom tag — verify it inserts into the active textarea at cursor position
4. Run a test campaign (or inspect the data object via log) — verify custom column values are substituted in templates
5. Verify a template with an unused placeholder like {nonexistent column} sends with that placeholder stripped
</verification>

<success_criteria>
- Any sheet column is available as a template placeholder without code changes
- Backwards compatibility: existing templates with {firstName} etc. work identically
- UI placeholder tags reflect actual sheet columns after preview
- Default tags shown before any sheet is loaded
- Multi-word and underscore placeholders cleaned from final messages
</success_criteria>

<output>
After completion, create `.planning/quick/260410-djm-add-dynamic-template-variables-from-goog/260410-djm-SUMMARY.md`
</output>
