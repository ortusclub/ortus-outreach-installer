---
phase: 2
slug: voice-selection-core
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-31
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Manual verification (Google Apps Script + sidebar UI) |
| **Config file** | none |
| **Quick run command** | `curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" "https://api.elevenlabs.io/v2/voices?page_size=5" \| python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\"voices\",[]))} voices returned')"` |
| **Full suite command** | Manual: open sidebar, verify dropdown, submit batch, check voice override |
| **Estimated runtime** | ~5s (API check) / ~120s (full manual test) |

---

## Sampling Rate

- **After every task commit:** Verify code changes via grep on `elevenlabs-apps-script.js`
- **After every plan wave:** Open sidebar, verify dropdown populated with voices
- **Before `/gsd:verify-work`:** Full test: select voice, submit batch, verify override in payload
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | VOICE-01 | grep | `grep "getVoiceList" elevenlabs-apps-script.js` | N/A | ⬜ pending |
| 02-01-02 | 01 | 1 | VOICE-01, VOICE-02 | grep | `grep "Loading voices" elevenlabs-apps-script.js` | N/A | ⬜ pending |
| 02-01-03 | 01 | 1 | VOICE-03 | grep | `grep "conversation_config_override" elevenlabs-apps-script.js` | N/A | ⬜ pending |
| 02-01-04 | 01 | 1 | VOICE-04 | grep | `grep "getUserProperties" elevenlabs-apps-script.js` | N/A | ⬜ pending |
| 02-01-05 | 01 | 1 | VOICE-08 | grep | `grep "if.*voice_id" elevenlabs-apps-script.js` | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No test framework needed — this phase modifies a single Google Apps Script file verified by grep + manual sidebar testing.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Voice dropdown populated in sidebar | VOICE-01 | Sidebar runs in Google Sheets iframe | Open sidebar, check dropdown has voice entries |
| Loading indicator shown | VOICE-02 | Visual UI state | Open sidebar, observe "Loading voices..." briefly |
| Selected voice used in batch call | VOICE-03 | Requires live API call | Select voice, submit batch, answer call, confirm voice |
| Last-used voice pre-selected | VOICE-04 | Requires sidebar close/reopen cycle | Close sidebar, reopen, check dropdown selection |
| No voice = no override | VOICE-08 | Requires API payload inspection | Submit without voice, check Logger output for payload |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
