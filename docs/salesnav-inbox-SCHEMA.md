# Sales Navigator inbox — captured schema (OP / InMail reply-check)

Captured live 2026-06-29 from `dwayne.co@ortus.solutions` against the Sales Nav
inbox. OPs and InMails are sent **through Sales Navigator**, so their replies
live here — NOT in the regular `messengerConversations` inbox the existing
reply-check reads. This needs a **separate reader**, but the match logic is the
same (numeric memberId).

## Endpoint
```
GET https://www.linkedin.com/sales-api/salesApiMessagingThreads?decoration=(id,restrictions,archived,unreadMessageCount,...)
```
- Replay the XHR via `page.evaluate(fetch)` with the JSESSIONID→csrf-token header,
  exactly like `getConversationsPage` for the regular inbox.
- The per-thread detail URL `salesApiMessagingThreads/<threadId>` returned 404 in
  capture — we only need the **list** endpoint (it already embeds messages).

## Envelope
```
{ data: { elements: [ Thread, … ] }, included: [ Profile, … ] }
```

### Thread (`data.elements[i]`, $type com.linkedin.sales.messaging.message.Thread)
- `id`                       → threadId (e.g. `2-OGU0MzU1…`)
- `participants[]`           → array of salesProfile URNs
- `messages[]`               → embedded messages (capture had the latest)
- `unreadMessageCount`, `archived`, `totalMessageCount`

### Message (`thread.messages[i]`, $type …message.Message)
- `author`     → salesProfile URN of the sender
- `type`       → `"INMAIL"` | `"MESSAGE"` (OP replies come back as MESSAGE)
- `body`       → **full text** (no truncation)
- `subject`    → InMail subject line (InMails only)
- `deliveredAt`→ epoch ms
- `id`

### Profile (`included[i]`, $type com.linkedin.sales.profile.Profile)
Resolve `participants[]` / `message.author` URNs against this by `entityUrn`.
- `entityUrn`  → `urn:li:fs_salesProfile:(ACwAA…,NAME_SEARCH,xxxx)` — the **ACwAA slug** (matches the sheet's profile URL)
- `objectUrn`  → `urn:li:member:<NUMERIC>` — the **numeric memberId** (matches the sheet's Member ID column) ← primary match key
- `firstName`, `lastName`, `fullName`
- `degree`     → 1 / 2 / 3
- `profilePictureDisplayImage.artifacts[].fileIdentifyingUrlPathSegment` → photo URL

## Matching to the sheet
The OP/InMail tab (same file, col C / col K) stores the numeric Member ID, and the
profile URL (col D) stores the ACwAA slug. Sales Nav hands us BOTH via `objectUrn`
and `entityUrn`, so we match by **numeric memberId first** (same cascade as
`matchParticipant` in inbox-sweep.js), ACwAA slug as backup. No ACwAA↔ACoAA bridge
needed here — Sales Nav already returns ACwAA.

## "Who replied" (inbound detection)
The account owner (e.g. dwayne.co) is one of the `participants`. A thread counts as
a lead reply when the **last message's `author`** resolves to the lead's memberId
(not the account owner's) — same `leadSentLast` logic, just on the Sales Nav author
URN. The first OUTBOUND message is the InMail/OP we sent (`type INMAIL` authored by us).
