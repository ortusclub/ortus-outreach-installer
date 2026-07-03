# messengerConversations — real schema (captured live 2026-06-29)

Captured from Antonio's own LinkedIn via `capture-inbox.mjs --local` against the
`messengerConversations.0d5e6781bbee71c3e51c8843c6519f48` query. This is the
`application/vnd.linkedin.normalized+json+2.1` envelope. The existing
`getConversationsPage`/`normalizeConversation` in `src/linkedin/helpers.js` DO NOT parse
this shape — they return empty. This doc is the contract for the rewrite.

## Envelope
```
{
  data: {
    data: {
      messengerConversationsBySyncToken: {
        metadata: {...},
        "*elements": [ "<conversation entityUrn>", ... ]   // URN REFERENCES, not objects
      }
    }
  },
  included: [ ...flat array of Conversation | Message | MessagingParticipant... ]
}
```
- Real query result is at `data.data.messengerConversationsBySyncToken` (NOT `data.messenger…`).
- `*elements` is a list of URN strings. Resolve each against `included` (index `included` by `entityUrn`).

## included entity: com.linkedin.messenger.Conversation
- `entityUrn`: `urn:li:msg_conversation:(urn:li:fsd_profile:<ME>,<threadId>)` — first tuple elem = the account owner ("me").
- `backendUrn`: `urn:li:messagingThread:2-…`
- `unreadCount`, `read` (bool), `groupChat` (bool), `lastActivityAt` (ms), `lastReadAt`, `createdAt`
- `categories`: ["INBOX","PRIMARY_INBOX"]
- `conversationUrl`: thread permalink
- `*conversationParticipants`: [ "urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAA…", ... ] — URN refs
- `messages."*elements"`: [ "<message entityUrn>" ] — URN ref to the latest message
- `*creator`: participant URN

## included entity: com.linkedin.messenger.MessagingParticipant
- `entityUrn`: `urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAA…`
- `hostIdentityUrn`: `urn:li:fsd_profile:ACoAA…`
- `backendUrn`: `urn:li:member:<NUMERIC>`   ← stable numeric memberId (the matching anchor)
- `participantType.member`:
  - `profileUrl`: `https://www.linkedin.com/in/ACoAA…`  (ACoAA form — NOT the sheet's ACwAA form)
  - `firstName.text`, `lastName.text`
  - `headline.text`, `distance` (DISTANCE_1/2/3), `profilePicture` (artifacts + rootUrl)

## included entity: com.linkedin.messenger.Message
- `entityUrn`: `urn:li:msg_message:(urn:li:fsd_profile:<ME>,<id>)`
- `body.text` (the message text), `deliveredAt` (ms)
- `*sender`: `urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoAA…`
- `*actor`: same form (present on outbound; may be null on some inbound)
- `*conversation`, `backendConversationUrn`

## Direction / "is this a reply?"
- "Me" = the `<ME>` fsd_profile that anchors every conversation/message `entityUrn` tuple
  (also the `*creator` / the sender of our own outreach templates).
- A thread is an INBOUND REPLY iff the latest message's `*sender` resolves to a participant
  whose fsd_profile ≠ ME. Read/unread is independent (operator may have opened it).

## Identity matching (sheet ↔ inbox)
- Sheet LinkedIn column = `…/in/ACwAA…` (public-URL obfuscation).
- Inbox participant = `…/in/ACoAA…` + `urn:li:member:<NUMERIC>` + clean name.
- ACwAA ≠ ACoAA (different encodings) → no direct string match.
- Bridge = numeric memberId. Voyager gives it free on the inbox side; the sheet side
  (ACwAA slug) must be resolved to numeric, OR fall back to name match with
  skip-on-doubt → unmatched bucket (Voyager's headline/company/photo/distance disambiguate).
```
