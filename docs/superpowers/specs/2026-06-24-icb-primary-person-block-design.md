# ICB Primary-Person Block — Design

**Date:** 2026-06-24
**Branch:** fg-team-launch-2116
**Status:** Awaiting user approval

## Goal

Give the Introduction Campaign (ICB, `introduce_back`) the same **Primary Person**
block that CC+IC (`connect_and_introduce`) has — Full name + LinkedIn URL +
"Logged in via" source — so the `{primary url}` placeholder resolves in ICB intro
DMs and the operator manages the primary in one place. Must NOT break ICB's
existing intro send or saved ICB campaigns.

## Background / why this is non-trivial

- ICB **already shows the `{primary url}` chip** (`app.js:3271` — IC mirrors CC+IC's
  chip layout) but has **no input** for the URL, and `gatherCampaignFormState`
  **blanks `primaryUrl`** for `_isIc` (`app.js:231-233`). So `{primary url}` in an
  ICB intro body resolves to empty today.
- ICB sources the primary's **name** from a separate field, `#intro-name`, inside
  `#intro-mode-block` (shown only for `introduce_back`, `app.js:1894`).
- **`#intro-name` is functionally load-bearing:** its value is typed into
  LinkedIn's recipient typeahead during the actual intro send (per the field hint
  at `index.html:1078`), AND it feeds `templates.introName` + `templates.primaryName`.
- CC+IC's `#primary-person-block` is gated to `connect_and_introduce` only
  (`app.js:1819`).

A literal "mirror" therefore means: adopt `#primary-person-block` as ICB's primary
UI, retire `#intro-name`'s **name-entry role** for ICB, and re-route ICB's
`primaryName` / `primaryUrl` / `introName` through the primary-person fields — with
fallbacks so the typeahead name and saved campaigns survive.

## Off-limits / constraints

- **No changes to `src/linkedin/outreach.js` or `src/linkedin/actions.js`.** The
  send path already reads `templates.introName` / `templates.primaryUrl`; we only
  change which DOM fields populate them at gather time. The typeahead keeps working
  as long as `introName` is still set.
- No expansion of auto-accept / follow-up to ICB — those stay CC+IC-only. We only
  add the primary **identity** (name/URL/source).
- Auto-relaunch `dev:app` after the commit; bump `package.json` version.
- Do NOT trigger a real LinkedIn send during verification.

## Design

### 1. Visibility (`onModeChange`)
- Show `#primary-person-block` when `mode === 'connect_and_introduce' || mode === 'introduce_back'`.
- **Hide `#intro-mode-block`** for `introduce_back` (it becomes redundant — its
  name role moves into the primary block). Keep the rest of `#ic-extras`
  (sender-column picker) for ICB.
- Inside `#primary-person-block`, **hide the `#primary-timing-field`** for ICB
  (timing the "connect/check to the primary" is a CC+IC concept; ICB leads are
  already connected). Show it only for `connect_and_introduce`.
- Keep the two-column intro-config layout working: the left column
  (`#intro-config-col-left`) currently shows only for CC+IC. Extend its predicate
  so the primary block is visible in ICB too. Auto-accept / follow-up blocks inside
  the left column stay hidden for ICB via their own CC+IC-only predicate.

### 2. URL is optional for ICB
CC+IC marks the URL required (`*`) because it drives the connection check. ICB only
needs it for the `{primary url}` token, so it must be **optional** in ICB:
- `revalidatePrimaryUrlField()` must not block ICB launch when the URL is empty.
- The `*` required marker is visually de-emphasised / hidden in ICB (cosmetic only;
  acceptable to leave the asterisk if validation is non-blocking — implementer's
  call, documented in the plan).

### 3. Gather routing (BOTH gather paths)
`gatherCampaignFormState` (~`app.js:170-245`) and the `startCampaign` gather
(~`app.js:4060-4290`) currently special-case `_isIc`. Change so ICB reads the
primary-person fields, with an `intro-name` fallback for un-migrated saved data:

```
// primaryName: ICB now reads primary-person-name, falling back to the legacy
// intro-name so saved ICB campaigns don't lose the primary's name.
const _icPrimaryName = (document.getElementById('primary-person-name')?.value?.trim() || '')
  || (document.getElementById('intro-name')?.value?.trim() || '');

primaryName: _isIc ? _icPrimaryName
           : (_isCcDm ? '' : (document.getElementById('primary-person-name')?.value?.trim() || '')),

// introName MUST stay populated for the typeahead. For ICB, mirror primaryName.
introName: _isIc ? _icPrimaryName
         : (document.getElementById('intro-name')?.value?.trim() || ''),

// primaryUrl: ICB now reads the field instead of blanking it. Only CC+DM blanks.
primaryUrl: _isCcDm ? '' : (document.getElementById('primary-person-url')?.value?.trim() || ''),
```
`primarySource` already routes via `readPrimarySource()` for `_isIntroFlow` (incl.
ICB) — no change.

### 4. Hydration / migration (`applyTemplateToForm`, ~`app.js:7960-7995`)
When loading a saved campaign into the form:
- Already sets `#primary-person-name` and `#primary-person-url` from
  `t.primaryName` / `t.primaryUrl` (`app.js:7973-7974`).
- ADD: if the campaign is ICB and `#primary-person-name` ends up empty but
  `t.introName` (or `#intro-name`) has a value, copy it into `#primary-person-name`
  so the migrated campaign shows the primary correctly in the new block.

### 5. Persistence
`savePrimaryPersonFields()` already persists name/url/source to localStorage. ICB
will share that store. `saveIntroFields()` (for `#intro-name`) can stay for any
non-ICB use of `#intro-mode-block`; it is simply hidden in ICB.

## Out of scope
- Auto-accept / follow-up for ICB.
- Any change to the LinkedIn send mechanics or selectors.
- `{intro X}` token vocabulary (already aliased to `{primary X}` in ICB).

## Test plan (manual, no real send)
1. Switch mode to Introduction Campaign → `#primary-person-block` visible with
   name + URL + source; `#intro-mode-block` hidden; `#primary-timing-field` hidden.
2. Enter a primary name + URL; preview an intro body containing `{primary url}` →
   resolves to the entered URL (was empty before).
3. Leave URL empty → launch is NOT blocked (URL optional in ICB).
4. Load an OLD saved ICB campaign that only had `intro-name` → the primary name
   appears in `#primary-person-name`; preview still shows the right name and the
   typeahead name (`introName`) is non-empty in the gathered payload.
5. Switch ICB → CC+IC → ICB and confirm no field bleed / phantom blocks.
6. CC+IC behaviour unchanged (regression check).
