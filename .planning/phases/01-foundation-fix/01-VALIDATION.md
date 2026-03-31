---
phase: 1
slug: foundation-fix
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-31
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Manual verification (Google Apps Script + ElevenLabs API — no automated test framework) |
| **Config file** | none |
| **Quick run command** | `curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/convai/agents/agent_5601kmzey4mve8pswpwvmhckcgnr` |
| **Full suite command** | Manual: submit test batch call, verify agent uses dynamic variables |
| **Estimated runtime** | ~60 seconds (API call) / ~120 seconds (test call) |

---

## Sampling Rate

- **After every task commit:** Run quick API check to verify agent config
- **After every plan wave:** Verify via test batch call
- **Before `/gsd:verify-work`:** Full test call must confirm variables are working
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | VARS-01, VARS-02, VARS-03 | manual | Browser paste + save verification | N/A | ⬜ pending |
| 01-01-02 | 01 | 1 | DASH-01 | manual | ElevenLabs dashboard toggle | N/A | ⬜ pending |
| 01-01-03 | 01 | 1 | DASH-02 | api | `curl GET /v1/convai/agents/{id}` — check prompt for {{variables}} | N/A | ⬜ pending |
| 01-01-04 | 01 | 1 | ALL | manual | Real test call — verify agent uses correct variables | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No test framework needed — this phase is deployment + configuration + API audit, verified by real test call.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Apps Script code is live | VARS-01, VARS-02, VARS-03 | Code lives in Google Apps Script editor, not local repo | Open Apps Script editor, verify code matches local file |
| TTS override enabled | DASH-01 | Dashboard toggle, not API-configurable | Navigate to agent Security tab, confirm toggle is on |
| Agent uses variables in speech | ALL | Audio output requires human listener | Submit test batch, receive call, listen for personalized greeting |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
