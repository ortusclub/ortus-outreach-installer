# Ask-First Protocol

**Rule, no exceptions:** Before writing or changing any code in response to a "build X" / "fix Y" / "the thing is broken" request, ask the user **two concrete questions** that they can answer with **real artefacts**, not opinions.

The cost of asking two questions is one minute. The cost of guessing wrong on a DOM scraper, a Sheets schema, or an API shape is hours of round-trip iteration. We've already paid that cost — this file exists so we don't pay it again.

## What counts as a "concrete artefact"

Anything that turns my hypothesis into a verifiable fact. Examples by category:

- **Web/DOM bugs** → "Open the page in DevTools, right-click on the broken element → Copy outerHTML, paste here." Or: "Run `document.querySelectorAll('<sel>').length` in the console and tell me the number."
- **Network/API issues** → "Open Network tab, trigger the action, paste the URL + status code + response preview of the failing request."
- **Stuff-doesn't-show-up bugs** → "Paste the full content of `tail -200 <log-file>`." Or: "Open `<sheet>` and screenshot row N showing what's actually written vs missing."
- **Visual/UI bugs** → A screenshot of the actual rendered state, plus what the user expected to see.
- **Behavior bugs** → "Reproduce the bug once and paste the exact sequence of clicks/inputs you did."
- **Schema/data bugs** → "Run `head -1 <csv>` (or first row of sheet) and paste the column names verbatim."
- **Decision/scope questions** → Two specific options with their tradeoffs, not "what do you want me to do?"

## Format

When the user asks me to build or fix something, my first response is:

> Two questions before I touch any code:
>
> **1.** [specific question with how to answer it — exact command, exact UI step, exact file]
>
> **2.** [specific question, ditto]
>
> [one-line explanation of what each answer unlocks for me]

Then I wait. I do NOT speculate, scaffold, or "start while you grab that." I wait.

## When to skip

Only when **all** of the following are true:

- The change is genuinely trivial (rename, single typo, comment-only).
- I have all the context already in this conversation (no DOM/log/schema unknowns).
- The user has shipped this exact change pattern with me before in this session.

Anything ambiguous: ask.

## What to ask if I'm completely stuck on what to ask

When I genuinely don't know the system shape, the two safest questions are almost always:

1. "Paste the relevant DOM/HTML/schema for the surface I'm touching."
2. "Paste the most recent log output (or the full error message + stack trace)."

Those two answers cover ~80% of bugs without any further clarification.

## Anti-patterns (what NOT to do)

- ❌ "I'll start with X and we can iterate." — Iteration is what we're trying to avoid.
- ❌ Asking yes/no questions when an artefact would tell me the answer.
- ❌ Asking only one question. Two questions force me to think about a second axis (e.g., DOM + state, not just DOM).
- ❌ "Can you check if X works?" That's a task for the user, not data for me. Reframe as "Run `<command>` and paste the output."

## Reminder for the user

If I forget this rule and start writing code from a vague prompt, you can shorten me with: **"ask first"** — and I'll stop and produce two questions.
