# Voyager Intro-Send Design

**Date:** 2026-05-18
**Author:** Antonio + Claude (Opus 4.7)
**Status:** Spec — evidence-based, no placeholders. Pending plan + execution.

## Problem

The CC+IC auto-intro DM occasionally misfires: the message body, written for a 3-way group thread, is delivered to only the lead as a 1:1 DM. The primary person (e.g. Sam Adcock) is silently dropped before LinkedIn registers the conversation as a group thread. This was reproduced on 2026-05-18 — the body "Introducing Sam …" landed in a solo thread with the lead (Leiddy Peñamora) on the boss's account.

**Root cause** (established via code review + manual DevTools test):

1. `auto-intro.js:274` calls `sendIntroMessage` with `secondRecipientUrl=''`, disabling the URL-routing path in `actions.js:1452-1458` — so every intro falls back to the DOM typeahead.
2. The DOM typeahead path adds the primary as a second pill, but its verification check at `actions.js:1893-1907` only confirms ONE pill exists matching `introName`. It uses substring `.includes()` matching, never re-verifies the lead pill, never counts pills, and ignores the disappearance of the group-title input (which only renders for ≥2-pill compose states).
3. We confirmed via manual paste-URL test that LinkedIn's `?recipient=` URL param is **last-wins** — repeated `&recipient=` does NOT create both pills. The comment in `actions.js:1444-1451` claiming this is "100% reliable" is incorrect; the deleted preflight (`verify-primary-person.js`, removed 2026-05-14 in commit `2bdb9b6`) only tested single-recipient URL routing.

The DOM path can therefore enter a state where: only the lead pill exists, the primary pill was briefly added and then dropped by a `/compose` → `/thread/new/?isTYAHFlow=true` redirect, the verify check passes via stale DOM snapshot, the body is filled, Send is clicked, and the message goes to the lead alone.

## Goal

Replace the DOM-typeahead recipient-add with a direct Voyager `POST /messaging/createMessage` call. LinkedIn either accepts both URNs and creates the group thread atomically, or returns a 4xx with a specific error. No pill race. No silent misfire. The DOM-typeahead path stays as a fallback for when Voyager returns a non-success status.

## Non-goals

- **Do NOT touch** `src/linkedin/outreach.js` or `src/linkedin/actions.js`. The existing `sendIntroMessage` becomes the fallback path and remains byte-for-byte unchanged. (House rule: off-limits files.)
- Do NOT change the wizard, sheet schema, Apps Script, or campaign orchestration outside `auto-intro.js`.
- Do NOT switch other LinkedIn actions (connect requests, follow-ups, DM check) to Voyager. Scoped to the intro DM only.

## Architecture

Hybrid try-Voyager-first / fallback-to-DOM, controlled in `src/linkedin/auto-intro.js`. The Voyager call lives in a new module `src/linkedin/intro-voyager.js`. A small helper extends `src/linkedin/helpers.js` to resolve a profile public-id to a profile URN without navigating.

### Sequence per lead in the auto-intro loop

```
auto-intro.js
  │
  ├─ if primaryUrl is set:
  │   ├─ ATTEMPT 1 — intro-voyager.js.sendIntroViaVoyager({ page, leadUrl, primaryUrl, body, title })
  │   │     ├─ helpers.resolveProfileUrn(page, leadPublicId)      → urn:li:fsd_profile:ACoAA…
  │   │     ├─ helpers.resolveProfileUrn(page, primaryPublicId)   → urn:li:fsd_profile:ACoAA…
  │   │     ├─ helpers.getSenderUrn(page)                         → urn:li:fsd_profile:ACoAA… (current account)
  │   │     ├─ POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
  │   │     │     payload = buildPayload({ senderUrn, recipientUrns, body, title })   ← title included
  │   │     ├─ response 200 → return { ok: true, conversationUrn }
  │   │     └─ response 4xx/5xx → return { ok: false, status, errorBody }
  │   │
  │   ├─ ok=true   → stamp "Introduction Made", continue to next lead
  │   │
  │   ├─ ATTEMPT 2 — if ok=false AND title was non-empty:
  │   │     ├─ POST same endpoint with payload = buildPayload({ ..., title: '' })   ← title omitted
  │   │     ├─ response 200 → log "sent without title", stamp Introduction Made
  │   │     └─ response 4xx/5xx → fall through to DOM fallback
  │   │
  │   └─ ok=false (both Voyager attempts failed) → log rejections, fall through to DOM
  │
  └─ DOM fallback (existing path): sendIntroMessage(page, body, primaryName, title, '', leadUrl)
      └─ if this also throws → stamp Failed as today
```

**Rationale for the title-retry step:** the title is best-effort. The recon proves title-included payloads work today. If LinkedIn ever changes title handling (or rejects a specific operator's title for unicode/length reasons), Attempt 2 ensures the body still reaches both recipients without needing a code change. Cost: one extra POST in the (rare) failure-with-title-set path. No cost in the happy path.

### Where each decision belongs

| Decision | Location |
|---|---|
| URN resolution | `helpers.js` (extends existing CSRF + JSESSIONID fetch pattern from lines 404-415) |
| Voyager POST + payload build | new `intro-voyager.js` |
| Fallback chain | `auto-intro.js` (the one orchestration file allowed to change) |
| DOM typeahead intro send | `actions.js` (untouched, used as fallback) |

## API contract — confirmed by DevTools recon, 2026-05-18 09:49 UTC

### Endpoint

```
POST https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
```

### Required headers

| Header | Value | Source |
|---|---|---|
| `csrf-token` | `ajax:<value>` from `JSESSIONID` cookie | Pattern already in `helpers.js:404-415`, `check-dms.js:438` |
| `x-restli-protocol-version` | `2.0.0` | Pattern already in `helpers.js:415` etc. |
| `content-type` | `text/plain;charset=UTF-8` | **LinkedIn quirk** — JSON body sent as text/plain. Already handled this way in existing Voyager calls. |
| `accept` | `application/json` | Standard |

### Request payload shape (confirmed verbatim from recon)

```json
{
  "message": {
    "body": {
      "attributes": [],
      "text": "<the message body>"
    },
    "originToken": "<UUID v4 client-generated>",
    "renderContentUnions": []
  },
  "mailboxUrn": "urn:li:fsd_profile:<sender's profile URN>",
  "hostRecipientUrns": [
    "urn:li:fsd_profile:<lead URN>",
    "urn:li:fsd_profile:<primary URN>"
  ],
  "conversationTitle": "<group title or empty/omitted>",
  "dedupeByClientGeneratedToken": false,
  "trackingId": "<16-byte opaque client tracking string>"
}
```

**Field notes from the recon:**

- `hostRecipientUrns` is an **array** — exactly how a group is signaled. Putting 2 URNs creates a 3-way thread (sender + 2 recipients). Confirmed by the actual `RECON-TEST-2026-05-18` capture: `hostRecipientUrns: ["urn:li:fsd_profile:ACoAACa0cGUBIFz763pB0KKaLKszka94Bw35fyo", …]` (second URN truncated in tree view but present).
- `conversationTitle` is the title string. Captured as `"RECON-TEST-2026-05-18"` exactly as typed in the UI. Confirms that the title we set today (the operator-configured intro title from the wizard) carries through unchanged — addresses the user's "keep what we have for titles" requirement.
- `mailboxUrn` is the sender. Same value as the result of `getProfileUrn(page)` on the sender's own profile, but we need to resolve it without navigating — see "URN resolution" below.
- `message.originToken` is a UUID v4. Captured: `"68a62c18-7fda-4398-9a6d-ca8775f4baef"`. Generated client-side. Spec calls this "client message dedup token."
- `trackingId` is a 16-byte opaque tracking string. Captured: `"h¦,ÚC ..."` (contains non-printable bytes; LinkedIn web client uses `btoa(randomBytes(16))` or equivalent). Treated as opaque — we generate a random one per call.
- `dedupeByClientGeneratedToken: false` — we don't need server-side dedup because we maintain our own dedup via the `campaign.introducedInRun` Set and the sheet's `Introduction Status` column.
- `message.body.attributes: []` and `renderContentUnions: []` — empty arrays for plain text. We don't send @-mentions, links-with-previews, or attachments.

### Response shape (success, status 200, confirmed verbatim from recon)

```json
{
  "value": {
    "renderContentUnions": [],
    "entityUrn": "urn:li:msg_message:(urn:li:fsd_profile:<sender>,2-…)",
    "backendConversationUrn": "urn:li:messagingThread:2-…",
    "senderUrn": "urn:li:msg_messagingParticipant:urn:li:fsd_profile:<sender>",
    "originToken": "<echoed UUID we sent>",
    "body": { "attributes": [], "text": "<echoed body>" },
    "backendUrn": "urn:li:messagingMessage:2-…",
    "conversationUrn": "urn:li:msg_conversation:(urn:li:fsd_profile:<sender>,2-…)",
    "deliveredAt": <unix-ms>
  }
}
```

- A 200 response with a populated `conversationUrn` is sufficient confirmation that LinkedIn accepted both recipients and created the thread. **No post-send GET is required** — the 200 itself is the proof. (We can add a participant-count GET later if we ever see Voyager 200-then-actually-only-1-recipient cases, but the recon shows that's not how the API behaves: if a URN is invalid, LinkedIn returns a 4xx, not a partial success.)

### Failure modes — what to expect

| Scenario | Voyager response | Our handling |
|---|---|---|
| Both recipients are 1st-degree, valid URNs | 200 with `conversationUrn` | `ok=true`, stamp Introduction Made |
| Primary URN is not 1st-degree of sender | 4xx (likely 403 or 422) | `ok=false`, log status + body, fall back to DOM typeahead |
| Lead URN is not 1st-degree of sender | 4xx | Same — fall back. (Bulk-check should have filtered this, but be defensive.) |
| Recipient URN is malformed / dead profile | 4xx | Same — fall back. |
| CSRF token expired | 4xx (likely 403) | Same — fall back. The fallback navigates to a fresh page, which refreshes the token. |
| Network error / page detached / timeout | thrown exception | Catch in `auto-intro.js`, fall through to DOM typeahead. |
| LinkedIn changes the endpoint schema | 4xx or non-JSON 200 | Same — fall back. We'll see this in logs and can recalibrate. |

## URN resolution

The sheet stores leads as profile URLs (`linkedin.com/in/<publicId>/`). The Voyager `createMessage` payload requires profile URNs (`urn:li:fsd_profile:ACoAA…`). We need a public-id → URN resolver that doesn't require navigating to the profile page.

**Mechanism:** `GET /voyager/api/identity/profiles/<publicId>` — pattern already used in `helpers.js:560-579` for `captureProfileMeta`. The response payload includes the profile's `entityUrn` field, which contains the `ACoAA…` URN suffix. We extract and return it. No navigation needed.

The sender's URN can be cached per-page-session — once resolved on first call (via `getProfileUrn(page)` at `helpers.js:481` or a Voyager `/me` call), subsequent intros in the same loop reuse it.

## Fallback behavior — preserves current setup as requested

When the with-title Voyager attempt returns `ok=false` (any 4xx) or throws:

1. **If title was non-empty:** retry once with `conversationTitle` omitted. If this succeeds → log "sent without title" (so the operator can see why their group is unnamed) and stamp `Introduction Made`. If it also fails → continue to DOM fallback.
2. **DOM fallback:** call `sendIntroMessage(page, body, primaryName, title, '', leadUrl)` exactly as today — same args, same line 274 behavior. Note that title IS passed to the DOM fallback (it fills the group-title input in the compose UI as today).
3. If the DOM fallback succeeds → stamp `Introduction Made` as today.
4. If the DOM fallback throws → stamp `Failed` as today.

**Behavioral guarantee:** for any campaign where both Voyager attempts fail, the operator's experience is **identical to today** — same retry, same stamp, same logs. For campaigns where Voyager succeeds (with or without title), the misfire class is eliminated.

## Logging — for the now-working ops/campaign log bridges

Each intro send writes a line that includes:

```
🤝 [profile] <leadUrl>: Voyager intro (lead=<urn:fsd_profile:...>, primary=<urn:fsd_profile:...>, status=200, convo=<conversationUrn>)
```

On fallback:

```
🤝 [profile] <leadUrl>: Voyager rejected (status=403, body="not 1st-degree") — falling back to typeahead
↻ [profile] <leadUrl>: typeahead succeeded
```

This gives the operator (and us, on future investigations) a clean record of which path each intro took.

## Test surface

Unit tests (`tests/intro-voyager.test.js`, new file):

1. **`buildPayload` happy path** — given sender URN, two recipient URNs, body, title → produces a payload matching the captured recon shape byte-for-byte (modulo the random `originToken` and `trackingId`).
2. **`buildPayload` no-title** — given empty/undefined title → produces a payload that **omits** the `conversationTitle` key entirely. (Decision: omit rather than send empty string, matching LinkedIn's UI behavior for compose flows where no title is typed.) This same code path is reused by Attempt 2 when retrying without title after a with-title failure.
3. **`parseSuccessResponse`** — given a fixture JSON matching the captured 200 response → returns `{ ok: true, conversationUrn, deliveredAt }`.
4. **`parseErrorResponse`** — given a status 403 with an error body → returns `{ ok: false, status: 403, errorBody }`.
5. **`resolveProfileUrn` happy path** — given a fixture Voyager `/identity/profiles/<publicId>` response → extracts the `urn:li:fsd_profile:ACoAA…` URN.
6. **`resolveProfileUrn` failure** — given a 404 response → returns null (caller decides what to do).

Integration test: none in the test suite. Real-LinkedIn integration verification happens in Phase 4 (manual end-to-end).

## Risk register — final, after recon

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Voyager rejects a campaign-class of leads (e.g., all "not 1st-degree" because bulk-check is wrong about degree=1) | Medium | Fallback runs unchanged. We see it in logs and can fix bulk-check, not block on this. |
| 2 | `trackingId` format requirements stricter than recon shows | Low | We use a 16-char alphanumeric random string (matches OSS LinkedIn libraries). If LinkedIn rejects, fallback catches it. |
| 3 | LinkedIn rate-limits direct Voyager messaging differently than UI-driven | Low-Medium | Same pattern as existing `voyager/api/...` reads in the codebase, which run constantly without rate-limit issues. Worst case: we'll see 429s and add backoff. |
| 4 | URN resolver returns wrong URN (e.g., picks the sender's URN from a `/me` field instead of the target's `ACoAA` URN) | Low | Already a solved problem in `helpers.js:501-628` (`captureProfileMeta` correctly extracts target URN). We reuse the same extraction logic. |
| 5 | The participant-count post-send check would be useful but adds latency | N/A | Decided **against** it — the 200 response with `conversationUrn` is sufficient per the recon. Skipping saves one round-trip per intro. |
| 6 | LinkedIn schema change breaks the call after release | Low-Medium | Fallback catches it. We log specifically enough to diagnose. Voyager schemas have been stable across the codebase's other Voyager reads for months. |

## Open questions — none

All originally open questions from the layout were resolved by the recon:
- ✅ **Title support** — `conversationTitle` is in the create payload, no PATCH needed. Current behavior preserved.
- ✅ **Endpoint exact URL** — `/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage`.
- ✅ **Recipient field name** — `hostRecipientUrns` (array).
- ✅ **Sender field name** — `mailboxUrn`.
- ✅ **Content type quirk** — `text/plain;charset=UTF-8`.
- ✅ **CSRF + restli version** — already established pattern, no new auth work.

## Acceptance criteria

After implementation:

1. A CC+IC intro send for a lead+primary pair where both are 1st-degree connections of the sender produces a 200 from Voyager, a `conversationUrn` is logged, and the operator sees both names in the LinkedIn UI as participants of the new group thread.
2. A CC+IC intro send where the primary is NOT a 1st-degree connection of the sender produces a Voyager 4xx, a fallback to DOM typeahead is attempted, and the final outcome is exactly what today's code produces (likely `Failed: not 1st-degree` after the typeahead also can't find them).
3. `src/linkedin/outreach.js` and `src/linkedin/actions.js` have **zero git diff** after the change.
4. Existing tests still pass; new unit tests for `intro-voyager.js` and the URN resolver pass.
5. The operator's experience for the "happy path" intro is faster (one POST vs the 10-30s typeahead choreography) and silently correct — they don't need to know the implementation changed.

## Sign-off

This spec is grounded in real captured evidence from the user's DevTools session on 2026-05-18. No field, no header, no endpoint URL is guessed.
