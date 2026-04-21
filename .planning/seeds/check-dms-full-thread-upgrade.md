---
title: Check DMs — fetch full thread text per reply
trigger_condition: Operators report clicking "Open Thread" frequently to read past the ~100-char inbox-list snippet
planted_date: 2026-04-21
related_phase: v3 Phase 11 (Check DMs)
---

# Seed: Full-thread text fetch for Check DMs

## What this is

Phase 11 ships with just the inbox-list snippet (first ~80–100 chars of the latest message). For long replies, the operator has to click "Open Thread" in LinkedIn to read the rest. If this becomes a frequent friction point, upgrade the Replies panel to show the full text of the most recent inbound message.

## Trigger to implement

Any of the following observed in practice:
- Operators mention "I keep clicking into threads to read the rest"
- Analytics on the "Open Thread" button show > ~50% click-through
- A teammate manually adds a workaround (copy-pasting replies into the sheet)

## Implementation sketch

After the inbox-list pass via `/voyager/api/messaging/conversations`, for each matched reply make a second Voyager call:
- `GET /voyager/api/messaging/conversations/{threadId}/events` — returns the full message event list for a thread.
- Extract the most recent inbound event's body, write it to the Replies panel and to the sheet (`Reply Preview` becomes "full text", capped at ~500 chars with an ellipsis).

## Cost / risk

- +1 API call per reply. For 5 replies/day that's nothing. For 50+ replies/day we'd want batching or parallelism.
- Voyager rate limits may apply — stagger if needed.

## Out of scope for this seed

Reading past messages in the thread (only need the latest inbound). Rendering rich content / emoji / images — text-only is fine.
