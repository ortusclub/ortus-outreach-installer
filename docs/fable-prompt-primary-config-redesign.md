# Fable prompt — redesign the CC+IC/CC+DM "primary person" config block (3 versions)

Paste everything in the fenced block below into Fable. It asks for **3 distinct
layout directions** for the crowded primary-person configuration area (the block in
the screenshot: Primary Person + Auto-accept + Auto-check cadence + Automated
follow-up). After a direction is picked, it gets built 1:1 in the real app.

---

```
Design 3 distinct layout directions for one settings area of a desktop LinkedIn-outreach
web app (an internal tool, not consumer). Monochrome "command-deck" aesthetic — think
Bugatti dashboard: near-black ink on off-white, thin hairline rules, generous whitespace,
UPPERCASE mono labels, a condensed display face (Bebas Neue) for big headings, Hanken
Grotesk for body, JetBrains Mono for labels/metadata. The ONLY accent color is a muted
gold, used sparingly and only on a primary call-to-action. Corner radius is either 0 or
fully pill (9999px) — nothing in between. No cards-on-cards, no drop shadows, no other
colors. Toggles are pill switches. Desktop width ~1100px, two-column friendly.

THE PROBLEM: this one area currently stacks FOUR separate bordered panels that are all
about the same thing — the "primary person" a new lead gets introduced to. It reads as a
wall of controls, it's overwhelming and unintuitive, and the relationships between the
panels aren't visible. I want it reorganized so it's scannable and the mental model is
obvious, without removing any capability.

Here is everything the area must contain (keep every control, just organize it well):

1. PRIMARY PERSON — "who the lead gets introduced to"
   - Full name (text)
   - LinkedIn profile URL (text, required)
   - "Logged in via" — a choice between "My local browser" and "A GoLogin profile"
     (when GoLogin is chosen, a profile picker appears). This one setting drives every
     primary-side action below.
   - "Primary check timing" — a dropdown: "After connections complete" vs "Immediately".

2. AUTO-ACCEPT THE CONNECTION (tag it NEW)
   - Toggle: "Auto-accept the primary's invitation." Sub-line: "Accepts as your primary —
     <your local browser / the chosen GoLogin profile>."
   - Helper text: "When an account isn't connected to your primary, it requests them and
     the chosen browser accepts that one invitation automatically — no manual step before
     the intro."
   - Second toggle: "Also accept all other pending invitations." This one carries a
     caution: "your primary also accepts EVERY pending invite in its inbox during
     pre-flight — including strangers, not just this campaign's senders."

3. AUTO-CHECK & INTRO CADENCE
   - Dropdown "Every [1 hour]" — how often to check each account for new acceptances and
     fire the follow-up.
   - Toggle "Run checks automatically."

4. AUTOMATED FIRST FOLLOW-UP (tag it NEW)
   - Toggle "Send a first follow-up (batched after the last intro)."
   - "Send after [10 minutes] after the last intro."
   - Sub-line: "Sent from your primary — <your local browser / the chosen GoLogin
     profile>."

IMPORTANT RELATIONSHIP TO SURFACE: everything under 2 and 4 "acts as the primary." The
"Logged in via" choice in panel 1 is the hinge — auto-accept and follow-up both run in
that same browser. Make that connection visible (e.g., a shared "acts as your primary"
motif), so the operator understands these aren't four unrelated boxes — they're the
primary's identity (1) and the three things done as that primary (2, 3, 4).

ONE MORE STATE TO ACCOUNT FOR: this campaign can be run "in the cloud" (on a VM) instead
of locally. When it's cloud AND the primary is "My local browser," the VM can't accept as
the primary, so the operator's own machine does a one-time accept handshake first, and the
automated follow-up is unavailable. The layout should have a graceful place to show a
short inline notice for that case (e.g., "Running in the cloud: your Mac does the primary
accept once, then it's all VM — follow-up is off for this setup") without cluttering the
default local view.

Give me THREE genuinely different directions, not three coats of paint on the same
layout. For example (feel free to invent better ones): (A) a single unified "Primary"
panel with the identity at the top and the three primary-side actions as a clean grouped
list beneath it; (B) a left identity column + right stacked-actions column, two-up; (C) a
progressive/stepped flow where each action reveals only once its prerequisite is set.
Label each version and add a one-line rationale for its organizing idea.
```
