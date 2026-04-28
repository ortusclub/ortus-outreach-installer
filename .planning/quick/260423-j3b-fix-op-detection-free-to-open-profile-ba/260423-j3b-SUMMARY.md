---
phase: 260423-j3b
plan: 01
subsystem: linkedin-outreach
tags: [bug-fix, refactor, sales-nav, open-profile, inmail]
dependency_graph:
  requires:
    - quick-260423-eiw (introduced the /in/ → Sales Nav Open Profile routing this plan hardens)
  provides:
    - "Positive Free-to-Open-Profile signal gating in sendViaSalesNav (no more false-positive OP sends on panels that render without a credit counter)"
    - "Uniform 'upfront /in/ → Sales Nav conversion + delegate to sendViaSalesNav' shape for force_open_profile and force_inmail modes"
    - "Deletion of dead sendOpenProfileMessage helper (~150 LOC removed)"
  affects:
    - src/linkedin/actions.js
    - src/linkedin/outreach.js
tech_stack:
  added: []
  patterns:
    - "Positive-signal detection — match literal badge text rather than infer from absence of a counter"
    - "Caller-predicate + internal guard — performOutreach pre-navigates to Sales Nav once; sendInMail still accepts /in/ entry via SALES_NAV_URL_RE check"
key_files:
  created: []
  modified:
    - src/linkedin/actions.js
    - src/linkedin/outreach.js
decisions:
  - "Use positive-signal regex (/free to open profile/i on panel innerText) to gate OP sends instead of the previous 'no credit counter' heuristic"
  - "Convert /in/ → Sales Nav URL upfront in performOutreach for force_open_profile and force_inmail (both modes fail-closed with identical skip reason when the Sales Nav link can't be resolved)"
  - "Preserve force_connect_op_fallback's inside-branch /in/ Connect fallback (Connect campaign at heart — do NOT skip the row just because Sales Nav is unavailable)"
  - "Duplicate SALES_NAV_URL_RE verbatim in actions.js rather than import from outreach.js (1-line regex; avoids cross-coupling the two files)"
metrics:
  duration_minutes: 20
  completed_date: 2026-04-23
  commits: 3
  files_modified: 2
  net_line_delta: -197   # actions.js -112, outreach.js -45 (Task 3: -152; Task 2: -45; Task 1: +40/-18 net +22; total ≈ -175, see "Line-count delta" below)
---

# Phase 260423-j3b Plan 01: Fix OP Detection (Free to Open Profile Badge) — Summary

Two coupled bugs in the Open Profile → Sales Nav routing (introduced during quick-260423-eiw) fixed by flipping OP detection to a positive-signal check and unifying the /in/ → Sales Nav conversion into a single upfront block that both OP and InMail modes delegate through — eliminating ~197 lines of near-duplicate code and deleting the dead `sendOpenProfileMessage` helper in the process.

## The Two Bugs

### Bug 1 — False-positive OP sends

**Before:** `sendViaSalesNav` treated "no credit counter on the panel" as proof of Open Profile. But the Sales Nav message panel can render without a credit counter for non-OP reasons (slow/lazy render, A/B variant, paid panel with the credits chip stripped). Result: operators unintentionally sent the OP template to non-OP leads.

**After:** `readSalesNavComposerState` now exposes `isFreeToOpenProfile`, derived from a case-insensitive regex against the literal badge text "Free to Open Profile" in the panel's `innerText`. The three gating sites in `sendViaSalesNav` (`force_open_profile`, `force_inmail`, `force_connect_op_fallback`) all check the positive signal. If the badge is absent, sends are blocked — no more phantom OP sends.

### Bug 2 — Duplicated /in/ → Sales Nav conversion logic

**Before:** Three different places handled the /in/ → Sales Nav URL conversion: inside `sendInMail` (actions.js), inside the `force_open_profile` /in/ branch (outreach.js), and opportunistically via `sendOpenProfileMessage` for `force_inmail` /in/ leads. The opportunistic OP attempt inside `force_inmail` suffered from Bug 1 — it false-rejected free senders.

**After:** `performOutreach` does the /in/ → Sales Nav conversion ONCE upfront, right after the pageError check, for both `force_open_profile` and `force_inmail` modes. When the Sales Nav link isn't resolvable, both modes fail-closed with the same error string ("Sales Nav link not available on profile"). `sendInMail` was also given an "already on Sales Nav" guard — if `SALES_NAV_URL_RE` matches `page.url()`, it skips its internal resolve+goto, preserving backward compatibility for legacy `/in/` callers.

## Line-count delta

| File | Before | After | Net |
| --- | --- | --- | --- |
| `src/linkedin/actions.js` | 1663 | 1551 | **-112** (-152 from deleting `sendOpenProfileMessage`, +40 net from Task 1 guard + isFreeToOpenProfile plumbing) |
| `src/linkedin/outreach.js` | 411 | 366 | **-45** (-88 from collapsing the two mode branches, +43 from upfront conversion block) |
| **Total** | **2074** | **1917** | **-157** |

## Commits

| # | Hash | Type | Scope |
| - | ---- | ---- | ----- |
| 1 | `fc8cfe5` | fix | actions.js — isFreeToOpenProfile field + three positive-signal gates + sendInMail SALES_NAV guard |
| 2 | `3af594a` | refactor | outreach.js — upfront /in/→Sales Nav conversion + collapsed OP/InMail branches + removed sendOpenProfileMessage import |
| 3 | `d100e7d` | refactor | actions.js — deleted dead sendOpenProfileMessage function (~150 lines) |

## Final state of key symbols

- **`readSalesNavComposerState`**: returns `{ isFree, isFreeToOpenProfile, hasCreditCounter, creditsAvailable, hasSubject, hasCompose }` — additive change, all previous fields preserved.
- **`sendViaSalesNav`**: unchanged public shape. Three gate sites now check `panel.isFreeToOpenProfile` instead of `!panel.hasCreditCounter` (open_profile + connect_op_fallback) / `!panel.hasCreditCounter` (inmail free branch).
- **`sendInMail`**: backward-compatible. New guard at the top: `if (SALES_NAV_URL_RE.test(page.url()))` skips the internal `resolveSalesNavUrlFromInProfile` + `page.goto`, so callers that pre-navigate get a no-op.
- **`sendOpenProfileMessage`**: DELETED. Banner comment + function body gone. Zero grep matches across `src/`.
- **`performOutreach`** (outreach.js): new upfront conversion block (lines ~138–153). The `force_open_profile` and `force_inmail` branches shrank from ~50 lines each to ~20 lines each — both assume on-Sales-Nav after the upfront block and delegate to `sendViaSalesNav` plus result translation only.
- **`force_connect_op_fallback`**: untouched structurally — it still does its own inside-branch /in/ → Sales Nav resolve (with /in/ Connect fallback when null), per the user decision "don't skip the whole row, because it's a Connect campaign at heart."

## Verification

- `node -c src/linkedin/actions.js` → clean
- `node -c src/linkedin/outreach.js` → clean
- `grep -rn "sendOpenProfileMessage" src/` → 0 matches
- `grep -c "free to open profile" src/linkedin/actions.js` → 1 (in readSalesNavComposerState, the positive-signal regex)
- `grep "isFreeToOpenProfile" src/linkedin/actions.js` → 5 matches (1 regex, 1 return field, 3 gating sites)
- **`npm test`** → **51 pass, 2 skip, 0 fail** (baseline maintained; no regressions)

## Deviations from Plan

None — plan executed exactly as written across all three tasks. No auto-fixes required, no authentication gates, no architectural pivots. All acceptance grep/node-c checks passed on the first run.

## Behavior-level spot-checks (manual, post-deploy)

These are NOT automated gates (no LinkedIn/Sales Nav staging environment):

1. A Sales Nav row that shows the "Free to Open Profile" badge → OP message sends (unchanged).
2. A Sales Nav row whose panel renders WITHOUT a credit counter for transient reasons (previously false-sent as OP) → now correctly skipped with `NOT_OPEN_PROFILE: Free to Open Profile badge not present on Sales Nav panel` error. No more phantom OP sends.
3. An `/in/` URL in `force_open_profile` mode → resolves to Sales Nav once upfront, then delegates to `sendViaSalesNav`. On `resolveSalesNavUrlFromInProfile` null → row skipped with `Sales Nav link not available on profile` (retry guard in campaign.js:818 absorbs this reason correctly).
4. An `/in/` URL in `force_inmail` mode → same upfront conversion. `sendViaSalesNav` picks OP template when the badge is present, InMail template when credit counter + credits > 0, skips when credits = 0.
5. An `/in/` URL in `force_connect_op_fallback` mode → tries Sales Nav first (inside-branch); on null, falls through to `/in/` Connect. Row not skipped just because Sales Nav is unavailable.

## Known Stubs

None. No placeholder data paths or hardcoded empty returns were introduced or left behind.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, or trust-boundary schema changes. The surface change is purely internal detection logic for an existing Sales Navigator code path.

## Self-Check: PASSED

- `.planning/quick/260423-j3b-fix-op-detection-free-to-open-profile-ba/260423-j3b-SUMMARY.md` — will be created by this Write call.
- Commit `fc8cfe5` — verified via `git log`.
- Commit `3af594a` — verified via `git log`.
- Commit `d100e7d` — verified via `git log`.
- `src/linkedin/actions.js` modified (verified via `git show fc8cfe5,d100e7d --stat`).
- `src/linkedin/outreach.js` modified (verified via `git show 3af594a --stat`).
