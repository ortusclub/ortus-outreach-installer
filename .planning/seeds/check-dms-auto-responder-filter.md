---
title: Check DMs — filter out autoresponder replies
trigger_condition: Operators report the Replies panel is noisy with "Thanks for connecting!" autoresponder messages
planted_date: 2026-04-21
related_phase: v3 Phase 11 (Check DMs)
---

# Seed: Auto-responder filter for Check DMs

## What this is

Phase 11 surfaces every reply as-is. Many prospects have LinkedIn autoresponders ("Thanks for connecting! I'll get back to you soon." / "Out of office until Monday.") that are effectively noise — they're not real engagement.

If this becomes painful, add a filter that demotes or hides likely autoresponders in the Replies panel.

## Trigger to implement

- Operators complain about having to scan past autoresponder spam to find real replies
- Measurable signal: > ~30% of surfaced replies are auto-generated (rough estimate — measure before implementing)

## Implementation options

1. **Phrase list** — match against common autoresponder openings: "thanks for connecting", "out of office", "thank you for your message", "i'll get back to you", "i'm currently travelling", etc. Case-insensitive substring match on the reply preview. Cheap and explicit.

2. **Length heuristic** — messages < 50 chars are usually acknowledgments or autoresponders; show but dim/collapse them.

3. **Speed heuristic** — replies arriving within < 60 seconds of our message are almost always automated. LinkedIn surfaces the timestamp; we already capture our send timestamp in `Date Last Action`. Compute delta.

4. **Hybrid** — combine 1 + 3 for best signal.

## UI treatment

Not delete/hide — just de-emphasize:
- Group under a collapsible "Likely auto-replies (N)" section at the bottom of the panel.
- Still write to the sheet as `Reply = "auto"` (not "yes") so operators can filter in-sheet too.

## Out of scope for this seed

Training an ML model. This is pattern-matching, not classification. If it needs ML, the problem has grown past this seed and wants its own phase.
