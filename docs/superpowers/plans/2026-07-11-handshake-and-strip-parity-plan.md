# Cloud Handshake (Path A) + Expanded-Strip Card #2 Parity — Implementation Plan

> **For agentic workers:** built task-by-task with tests + commits. Steps use
> checkbox syntax. Handshake (Feature 1) ships first — it's the critical bug.

**Goal:** (1) Make a cloud CC+IC campaign with a local-only primary actually send
the sender→primary connection requests, by running the handshake locally before
dispatch. (2) Make an expanded dashboard strip look exactly like card #2.

**Tech Stack:** vanilla ESM + Express 4, Node ≥22, `node --test`, no bundler.

## Global Constraints

- **Never edit** `src/campaign.js`, `src/linkedin/outreach.js`,
  `src/linkedin/actions.js`, `src/linkedin/accept-invitation.js`,
  `src/local-launcher.js`, `src/primary-task-runner.js`, `src/primary-tasks.js`.
  Import + call their exports only.
- **Never `git add`** `data/monitoring-campaign.json`, `.claude/worktrees/`,
  `.superpowers/`. Add named files only.
- Bugatti design system: monochrome, hairlines, gold only on Start CTA, radii
  0/9999. No new colours/tokens for the strip parity (reuse `.vj-*` / `.hs-*`).
- Bump `package.json` version + both `index.html` `?v=` before each relaunch.
- Commit trailers: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  and `Claude-Session: https://claude.ai/code/session_0158VcKf18rWqwaLtm94oFyP`.
- Path B (engine hard-lock) stays dormant + untouched.

---

# FEATURE 1 — Cloud handshake Path A (local pre-dispatch)

## Task 1.1 — `src/cloud-preflight-handshake.js` module (+ unit tests)

**Files:**
- Create: `src/cloud-preflight-handshake.js`
- Test: `tests/cloud-preflight-handshake.test.js`

**Interfaces:**
- Produces: `runCloudPreflightHandshake(opts)` and pure helper
  `needsCloudHandshake({ mode, autoAcceptPrimary, primarySource })`.
- Consumes (import, never edit): `planAccountsNeedingConnect`
  (`./preflight-handshake.js`), `checkAndConnectPrimary`
  (`./linkedin/primary-connection.js`), `readSelfIdentity`,
  `acceptInvitationFrom`, `acceptAllPendingInvitations`
  (`./linkedin/accept-invitation.js`), `buildAcceptTask`, `enqueuePrimaryTask`
  (`./primary-tasks.js`), `loadPrimaryStatus`/`savePrimaryStatus` (whichever
  module exports them — confirm at build), launchers (`./gologin-launcher.js`,
  `./local-launcher.js`).

**Signature (from spec):**
```
needsCloudHandshake({ mode, autoAcceptPrimary, primarySource }) =>
  mode === 'connect_and_introduce' && autoAcceptPrimary === true
  && (primarySource || 'local-browser') === 'local-browser'

async runCloudPreflightHandshake({
  senderProfileIds, primaryUrl, primarySource='local-browser',
  autoAcceptAllPending=false, token,
  onProgress=()=>{},
  // injectable deps (default to the real imports) for testing:
  deps={}
}) => { ok, connected, accepted, pending, senders:[{profileId,name,state}] }
```

**Flow** (mirror `runPreflightHandshake` in `src/campaign.js:4826`, but standalone):
1. `loadPrimaryStatus`; seed connected senders; `planAccountsNeedingConnect`.
2. If `need.length===0 && !autoAcceptAllPending` → return `{ok:true, connected:…, accepted:0, pending:0, senders}` (self-eliminating, launches nothing).
3. For each `need`: `launchProfile(id, token)` → `checkAndConnectPrimary(page, primaryUrl, {attemptConnect:true})` → on outstanding-invite `readSelfIdentity` → `buildAcceptTask({...})` push; `closeProfile(id)`. `onProgress({profileId, state})` at each step; on error log+skip (never throw out of the loop).
4. If queued accepts or `autoAcceptAllPending`: `launchLocalBrowser()`; accept loop with `CAP_MS=120000`, `POLL_MS=30000` (copy the cap/poll shape); `onProgress` `accepting→connected`. If `autoAcceptAllPending` run `acceptAllPendingInvitations(page)`. `closeLocalBrowser()`.
5. `enqueuePrimaryTask` leftovers; `savePrimaryStatus`; return summary.

**Tests** (inject fake deps — no real browser):
- `needsCloudHandshake` matrix: CC+IC+auto+local→true; GoLogin-primary→false; auto off→false; `connect_only`→false; `connect_and_message`→false.
- Self-elimination: all senders seeded connected + accept-all off → `ok:true`, fake launchers never called.
- Happy path: 2 senders needing connect, fake `checkAndConnectPrimary` returns `{connected:false, connectAttempted:true}`, fake `readSelfIdentity` returns identity, fake accept returns `{accepted:true}` → summary `{connected:2, accepted:2, pending:0}`, `buildAcceptTask` called twice.
- Accept timeout: fake accept returns `{accepted:false}` → leftover `enqueuePrimaryTask` called, `pending>0`, still `ok:true`.

- [ ] Write the module.
- [ ] Write tests; `node --test tests/cloud-preflight-handshake.test.js` → PASS.
- [ ] Commit.

## Task 1.2 — server route `POST /api/campaign/cloud-preflight-handshake`

**Files:**
- Modify: `server.js` (add route near the other `/api/campaign/cloud/*` routes)

**Behavior:** body `{ senderProfileIds, primaryUrl, primarySource, autoAcceptAllPending }`.
Stream progress with SSE using the SAME helper the campaign-view stream uses
(`openCampaignViewStream` pattern) — if that's awkward, fall back to: run the
handshake, buffering `onProgress` events, and expose `GET
/api/campaign/cloud-preflight-handshake/status` returning the latest snapshot
(single in-flight handshake at a time — store it in a module-level var). Pick
the poll approach if SSE wiring isn't already trivially reusable. Return the
final summary JSON on completion. Token from env (never from the client).

**Test:** a light supertest-free check is hard here (browser). Instead: a unit
test that the route handler, given an injected `runCloudPreflightHandshake` stub,
returns the summary and 200; and returns 400 when `senderProfileIds` is empty.
Keep the handler thin (delegate to the module) so this is meaningful.

- [ ] Add route (thin; delegates to the module).
- [ ] Add handler unit test (inject stub) → PASS.
- [ ] Commit.

## Task 1.3 — client wizard in `_submitCloudCampaign` + `campaigns-client` call

**Files:**
- Modify: `public/js/app.js` (`_submitCloudCampaign`, new `runHandshakeWizard`)
- Modify: `src/campaigns-client.js` (add `cloudPreflightHandshake` fetch helper if
  the client calls through the server proxy — confirm the client→server call path)
- Modify: `public/css/style.css` only if the `.hs-*` panel classes need a modal
  wrapper (reuse existing `.hs-*`; add minimal `.hs-modal` shell if none exists)

**Behavior (from spec):** before the `start-cloud` fetch, compute
`needsHandshake` from `body` (confirm exact keys: `body.mode`,
`body.templates.autoAcceptPrimary`, `body.templates.primarySource`,
`body.templates.primaryUrl`, `body.profileIds`). If true, `await
runHandshakeWizard(...)`: open a modal reusing `.hs-*` styling, one row per
sender, live state via the SSE/poll from Task 1.2, a "runs on your Mac — keep the
app open" note. On success auto-close → proceed to dispatch (unchanged) →
`openCloudLive(id)`. On hard failure offer Retry / Dispatch anyway / Cancel;
Cancel returns without dispatching.

**Test:** pure helper `needsHandshakeFromBody(body)` extracted + unit-tested
(mirror `needsCloudHandshake`, reading the body shape). Wizard DOM verified via
CDP at the feature's end.

- [ ] Add `needsHandshakeFromBody` (pure) + test → PASS.
- [ ] Add `runHandshakeWizard` + wire into `_submitCloudCampaign`.
- [ ] Add `campaigns-client` helper + confirm client→server path.
- [ ] Bump version, relaunch, CDP-verify the wizard renders for a CC+IC+local
      config and is skipped otherwise. Commit.

## Task 1.4 — Feature 1 review + verify

- [ ] `node --test tests/` full suite green.
- [ ] Dispatch a code-review subagent on the Feature-1 diff.
- [ ] Address Critical/Important findings; re-run tests.

---

# FEATURE 2 — Expanded-strip card #2 parity

## Task 2.1 — `vjCardSkeleton(cid)` + `fillVjCard(root,status)` (+ tests)

**Files:**
- Modify: `public/js/app.js` (new functions; `renderActiveCard` UNTOUCHED)
- Test: `tests/vjcard-template.test.js` (jsdom-free string assertions)

**Detail:** `vjCardSkeleton(cid)` returns the `#active-card` markup
(`public/index.html:281-380`) with every `id="X"` → `data-f="X"`, wrapped
`<div class="vj-card sn-vjcard" data-cid="…">`. `fillVjCard(root,status)` = a
scoped mirror of `renderActiveCard`'s field-fill using
`root.querySelector('[data-f="…"]')`; toggles `is-monitor`/`is-detailed` on
`root`; always `is-detailed`. Pure helper `vjCardFields(status)` returns the
{name, pct, sent, total, accepted, monCount, logRows[], bulk…} object so it's
unit-testable without a DOM.

**Tests:** `vjCardFields` for a running-cloud, monitoring-cloud, done status →
correct values + monitoring/hidden flags. `vjCardSkeleton` string contains
`data-f="activeName"`, no `id="active` collisions.

- [ ] Functions + tests → PASS. Commit.

## Task 2.2 — `statusFromItem(it)` + control matrix helper (+ tests)

**Files:**
- Modify: `public/js/app.js`
- Test: `tests/status-from-item.test.js`

**Detail:** `statusFromItem(it)` maps a board item to the `fillVjCard` status
shape (reuse `_buildCloudActiveStatus` mapping for cloud). `vjCardControlsFor
(status)` (pure) returns the dock button set + onclick strings per the spec
matrix (local/cloud × running/monitoring/done/queued). Unit-test every matrix row.

- [ ] Functions + tests → PASS. Commit.

## Task 2.3 — board integration + 1s ticker

**Files:**
- Modify: `public/js/app.js` (`renderUnifiedStrip` expanded branch → emit
  `vjCardSkeleton`; post-render fill pass; `_vjCardTick` shared 1s countdown;
  hide `.sn-foot` when expanded), `public/css/style.css` (only if the
  `.sn-vjcard` inside a strip needs layout tweaks — reuse `.vj-*`).

**Detail:** when `!collapsed`, body = `vjCardSkeleton(it.id)` in place of
`switchBlock`+`monBlock`; omit `.sn-foot`. After each board render, walk
`#sn-board .sn-strip:not(.sn-collapsed) .sn-vjcard` → `fillVjCard(el,
statusFromItem(item))`. Start `_vjCardTick` (1s, updates `[data-f="monCount"]`
by data-cid) when ≥1 open; stop when none. Collapsed path unchanged.

- [ ] Implement. Bump version, relaunch.
- [ ] CDP-verify: expand running-cloud, monitoring-cloud, done → pixel parity
      with `#active-card`; countdown ticks; RUN CHECK NOW works; collapsed
      unchanged; `#active-card` singleton untouched. Commit.

## Task 2.4 — Feature 2 review + verify

- [ ] Full suite green.
- [ ] Dispatch a code-review subagent on the Feature-2 diff.
- [ ] Address Critical/Important; re-verify via CDP.

---

## Final

- [ ] Full `node --test tests/` green.
- [ ] Both features CDP-verified against the live monitoring campaign.
- [ ] Written report for the operator: what shipped, what's verified, what needs
      a real VM launch to confirm, and the Path B / engine-deploy dependency.
