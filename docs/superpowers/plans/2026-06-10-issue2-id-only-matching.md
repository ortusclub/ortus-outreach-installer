# Issue #2 — ID-only bulk-check matching (kill name-match false positives)

> **For agentic workers:** Execute via superpowers:subagent-driven-development, TDD. Steps use `- [ ]`.

**Goal:** The CC+IC acceptance check must never stamp/introduce a lead off a NAME match. A lead is "connected" only on a real LinkedIn identity hit (public slug, AC**AA URN-token, or numeric Membership ID) owned by an active sender.

**Architecture:** One pure function — `computeBulkCheckUpdates` in `src/linkedin/bulk-check-connections.js` — does all matching. Change is surgical: stop feeding `nameToAccounts` into the match set; add a numeric `memberNumber` index (additive). Reuse `readSourceMemberId` from `src/profile-identity.js` (read-only; do NOT modify that file).

**Tech Stack:** vanilla ESM, `node --test`.

**v2.86.10 invariant (must hold):** Do not touch `src/profile-identity.js` semantics; keep all 18 `tests/profile-identity.test.js` green. #2 reinforces v2.86.10 (the "Already Connected + empty Membership ID" fingerprint becomes unmatchable at the bulk layer too).

---

### Task 1: Failing tests — ID-only matching

**Files:**
- Test: `tests/bulk-check-connections.test.js` (append new cases; match existing `describe`/`test` style in the file)

- [ ] **Step 1: Write the failing tests.** Add cases asserting:
  1. **Vito repro (name-only, cross-account, unsent → NO stamp/intro):**
     ```js
     test('name-only match does NOT stamp or introduce (cross-account, unsent)', () => {
       const rows = [{
         'First Name': 'Vito', 'Last Name': 'Mansueto',
         'Linkedin Bio': 'http://www.linkedin.com/in/ACwAAAZLmE8Bl3D54RBLDEXg2MwvxPE4JoIyLX8',
         'Sender': '', 'Connection Request Status': '', 'Linkedin Membership ID': '',
       }];
       // A DIFFERENT account has a connection that only shares the NAME (different token, no slug, no numeric id).
       const conns = [{ account: 'abhinay@x', firstName: 'Vito', lastName: 'Mansueto', urn: 'urn:li:fsd_profile:ACoAAAZLmE8Be4SdifferentXYZ', publicId: '', memberNumber: '' }];
       const { updates, connectedUrls } = computeBulkCheckUpdates(rows, conns, 'Linkedin Bio', 'Still Pending', { profileName: 'abhinay@x' });
       assert.equal(connectedUrls.length, 0);
       assert.ok(!updates.some(u => /connected/i.test(String(u.cc || '')) || /connected/i.test(String(u.stage || ''))));
     });
     ```
  2. **Numeric Membership ID match works (no slug/token), correct sender:**
     ```js
     test('numeric Membership ID match stamps Connected for the assigned sender', () => {
       const rows = [{
         'First Name': 'Real', 'Last Name': 'Lead',
         'Linkedin Bio': 'http://www.linkedin.com/in/ACwAAReal',
         'Sender': 'rilany@x', 'Connection Request Status': 'Connection Request Sent',
         'Linkedin Membership ID': '105617487', 'LinkedIn URN': '',
       }];
       const conns = [{ account: 'rilany@x', firstName: 'Real', lastName: 'Lead', urn: '', publicId: '', memberNumber: '105617487' }];
       const { updates, connectedUrls } = computeBulkCheckUpdates(rows, conns, 'Linkedin Bio', 'Still Pending', { profileName: 'rilany@x' });
       assert.equal(connectedUrls.length, 1);
       assert.ok(updates.some(u => u.cc === 'Connected'));
     });
     ```
  3. **G3 — v2.86.10 fingerprint at the bulk layer (empty Membership ID + no token + matching name → NO stamp):** same shape as case 1 but assert explicitly no `cc`/`checkStatus` Connected write.
  4. **Token match still works (regression):** row `LinkedIn URN` = `ACoAAReal`, conn `urn` = `urn:li:fsd_profile:ACoAAReal`, sender matches → `cc:'Connected'`, `connectedUrls.length === 1`.

- [ ] **Step 2: Run, verify red.**
  Run: `node --test tests/bulk-check-connections.test.js`
  Expected: cases 1 & 3 FAIL (current code name-matches Vito → stamps "Already connected" + pushes connectedUrls); cases 2 & 4 may pass/fail depending — at least 1 & 3 must fail for the right reason (name match).

---

### Task 2: Implement ID-only matching + numeric index

**Files:**
- Modify: `src/linkedin/bulk-check-connections.js`

- [ ] **Step 1: Import the numeric reader.** At the top imports (after line 26), add:
  ```js
  import { readSourceMemberId } from '../profile-identity.js';
  ```

- [ ] **Step 2: Build a numeric memberNumber index; keep name index for DIAG only.** In the `for (const c of conns)` loop (around lines 101-111), after the `nameKey` line add:
  ```js
  const memberNumber = String(c.memberNumber == null ? '' : c.memberNumber).replace(/\D/g, '');
  if (memberNumber) _addAcct(memberNumberToAccounts, memberNumber, acct);
  ```
  And declare the map alongside the others (near line 93):
  ```js
  const memberNumberToAccounts = new Map();
  ```
  Leave `nameToAccounts` populated (diag continuity) but add a comment that it is **no longer a match key** (v2.86.12 — name matching caused cross-account false positives, e.g. Vito Mansueto).

- [ ] **Step 3: Swap name → numeric in the row match.** Replace the name contribution at line 202:
  ```js
  if (nameKey && nameKey !== ' ') for (const a of (nameToAccounts.get(nameKey) || [])) _matchedAccounts.add(a);
  ```
  with:
  ```js
  // v2.86.12: NAME is no longer a match key (cross-account false positives —
  // e.g. Vito Mansueto stamped + introduced off a namesake on an unsent row).
  // Match only on strong identity: slug (line 200), AC**AA token (line 201),
  // or numeric Membership ID (below). readSourceMemberId reads the sheet's
  // numeric id; memberNumberToAccounts holds the connections' numeric ids.
  const rowMemberNumber = readSourceMemberId(row);
  if (rowMemberNumber) for (const a of (memberNumberToAccounts.get(rowMemberNumber) || [])) _matchedAccounts.add(a);
  ```

- [ ] **Step 4: Surface the numeric index in diag (observability).** In the returned `diag` object (the main return near line 477+) add `memberNumbers: memberNumberToAccounts.size,` next to the existing `memberIds`/`names`. Also add it to the early-return diag (the `senderScopingActive && !callerIsActiveSender` block ~line 146) for shape consistency.

- [ ] **Step 5: Run the targeted tests, verify green.**
  Run: `node --test tests/bulk-check-connections.test.js`
  Expected: all four new cases PASS; pre-existing cases in the file still PASS.

- [ ] **Step 6: Run the full suite (v2.86.10 guard).**
  Run: `node --test tests/*.test.js`
  Expected: ALL pass — especially `tests/profile-identity.test.js` (18), `tests/idle-bulk-check.test.js`, `tests/monitoring-tick.test.js`. 0 fail.

---

### Task 3: Version bump + commit + relaunch

- [ ] **Step 1:** Patch-bump `package.json` 2.86.11 → 2.86.12.
- [ ] **Step 2: Commit.**
  ```bash
  git add src/linkedin/bulk-check-connections.js tests/bulk-check-connections.test.js package.json docs/superpowers/specs/2026-06-10-ccic-reliability-and-pause-edit-design.md docs/superpowers/plans/2026-06-10-issue2-id-only-matching.md
  git commit -m "fix(bulk-check): ID-only matching — drop name keys, add numeric Membership ID (v2.86.12)"
  ```
- [ ] **Step 3: Relaunch** (only after confirming no campaign is running):
  ```bash
  pkill -f "npm.*dev:app" 2>/dev/null; pkill -f "Electron.*[Oo]rtus" 2>/dev/null; pkill -f "node_modules/electron/dist" 2>/dev/null
  npm run dev:app > /tmp/dev-app.log 2>&1 &
  ```

---

## Notes for the implementer
- **DO NOT** modify `src/profile-identity.js`, `src/linkedin/outreach.js`, `src/linkedin/actions.js`.
- **DO NOT** rename or change any status string ('Connected' / 'Already connected' / 'Already Connected'). #1 (label rename) is dropped.
- The legit "pre-existing 1st-degree connection" path (empty Sender + strong-ID match → 'Already connected' + intro) MUST keep working — only NAME-based matches are removed.
- Match the existing test file's import style and assertion library (`node:assert`, `node:test`).
