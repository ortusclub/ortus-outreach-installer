# Feature Suggestions Backlog — 2026-06-18

Raw suggestions from Antonio, captured before a brainstorming pass. Faithful to intent;
typos cleaned. **NOT yet designed** — this is triage input. Each item gets its own
brainstorm → spec → plan as we pick it up. Given the volume and the mix of independent
subsystems, we triage and tackle in batches, not all in one spec.

## A · Quick-ish fixes / UX
1. **Disable auto-checks** — an option to turn off automatic checks so the operator can run processes manually instead.
2. **Bench accounts mid-campaign** — fix the workflow so an account can be benched without a full manual stop → restart sequence.
3. **Pause/resume captures changes** — when a campaign is paused and resumed, accurately pick up changes to GoLogin accounts or spreadsheet variables made in between.
4. **"Unnecessary connection note" nudge** — a UI prompt that discourages leaving connection notes when they aren't needed.
5. **Account-selection guardrails** — prevent selecting "Passover" accounts, or accounts reserved by other owners.
6. **Auto-login when logged out** — if an account is logged out, log it back in automatically.

## B · Checks / verification model
7. **Dynamic Primary/IC/CC checks** — run checks progressively as the campaign runs, instead of one big bulk check at the start.
8. **Persistent "Primary" status store** — a dedicated database to remember Primary status across sessions, avoiding repeated verification.

## C · Dashboard / reporting
9. **Operational Funnel** — ⚠️ NEEDS CLARIFICATION: a funnel view on the dashboard? Scope TBD.
10. **SoO throughput counters** — track CCs per week and Operations per month directly on the SoO dashboard.
11. **Record OP replies in the sheet** — detect and write operator/lead replies back into the sheet.

## D · Integrations
12. **Auto-update HubSpot** — push updates to HubSpot automatically.
13. **Auto-draft / auto-reply** — "do what the Ukraine email tool does" and automatically write the reply. ⚠️ NEEDS CLARIFICATION: which tool / exactly what behaviour.
14. **Auto-caller + SMS integration** — bring the Vapi automated calling + SMS into this app.

## E · Platform / architecture (big — design carefully)
15. **Fix auto-update** — resolve whatever is preventing the app from updating itself automatically.
16. **Is a Mac app the right call?** — step back and evaluate whether an Electron macOS app is the best platform vs alternatives.

## Notes for the brainstorm
- Mix of bug-fixes, small UX, and large new subsystems (DB, HubSpot, AI auto-reply, telephony, possible platform rewrite). Decompose — don't design it all in one go.
- Likely cross-refs to existing memory: auto-update (boss-divergence: releases ship from branch, updater compares numerically), Primary status (primary-side identity model), auto-caller + SMS (simple automated calling system), funnel (lead lifecycle funnel), HubSpot (Ortus HubSpot extension).
- Suggested first triage axis: **(a)** is it a bug-fix vs new feature, **(b)** blast radius / risk, **(c)** does it touch off-limits files (`outreach.js`/`actions.js`) or the shared Apps Script.
