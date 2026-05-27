# Multi-Tenant Cloud Version of Ortus Outreach — Plan & Boss Message

**Captured:** 2026-04-30
**Status:** Awaiting boss alignment before any code is written

---

## Background

Boss originally asked: *"Run the GoLogin accounts on a VM (we have several available, e.g. VM_17 — Ubuntu/Ionos) so colleagues' Macs aren't burdened by the browsers."*

That direction was investigated. **It's not enough at our scale.** The investigation pointed to a much bigger architectural shift: a proper multi-tenant cloud version of the tool.

Related existing docs:
- `CLOUD-EXECUTION-PROPOSAL.md` — earlier April 2026 memo with Options 1–3 (GoLogin Cloud Launcher / self-hosted VM / status quo). This new plan **supersedes** that memo for the 100-user scenario.
- `.planning/research/LINUX-VM-FEASIBILITY.md` — deep research on running the current tool on a single Linux VM. Confirms Linux/GoLogin compatibility but doesn't address multi-user scale.

## The real requirements (from operator: 2026-04-27)

1. **No RAM burden on colleagues' MacBooks.** Their machines should stay free for other work.
2. **Campaigns must survive laptops closing.** Long campaigns (overnight, weekends) need to keep running.
3. **~100 colleagues**, each with their own private app install.
4. **Concurrent campaigns per user.** Example: Antonio runs 4 campaigns + Milena runs 5 + others — all at the same time.
5. **No third-party outreach tools.** Operator explicitly rejected Expandi / Dux-Soup / HeyReach etc. We own this ourselves.

## Why "just put it on a VM" doesn't satisfy these

### Problem 1: A VM is essentially a second computer — only one person can use it at a time

If Antonio is running 4 campaigns on VM_17, that VM is fully occupied. Milena can't run her 5 campaigns there — she has to wait, or get a different VM. With 100 colleagues running campaigns concurrently, this would mean roughly one VM per active user. Expensive and unmanageable.

### Problem 2: A VM alone doesn't solve campaigns running overnight

As long as the campaign **controller** still runs on each colleague's MacBook (even if the browsers are on the VM), closing the laptop kills the campaign. The laptop still has to stay open.

### Problem 3: GoLogin Cloud Launcher (paid shortcut) has the same flaw

GoLogin's own paid Cloud Launcher service moves browsers to their infrastructure but still requires each colleague's laptop to stay on to orchestrate. Plus per-hour fees (~$500–2,000/mo at 100-user scale). Same limitation as VM-only fix, plus wasted budget. Rejected.

## The actual answer: a proper multi-tenant cloud version

### Architecture in plain terms

**Today** (every colleague's Mac is an island):
```
[Mac] = dashboard UI + templates + browsers + campaign loop + state files
```

**Cloud version** (split into two halves):
```
Each colleague's Mac (the "client")        The cloud (the "server")
────────────────────────────────────       ────────────────────────────
- Electron app (dashboard UI)              - User accounts / login
- Template editor                          - Templates + sheets + history (Postgres)
- "Start Campaign" button                  - Campaign job queue (BullMQ / SQS)
- Status / live logs viewer                - Worker pool (runs the browsers)
                                           - GoLogin profile launcher
                                           - Browser autoscaling (3 → 60 workers)
```

The Mac becomes a **thin client / remote control**. The cloud does all the heavy lifting.

### Concrete flow: Antonio launches a campaign

1. Antonio clicks **Start Campaign** on his Mac.
2. Mac sends a small JSON message to the backend: *"user=antonio, profiles=[a,b,c,d], sheet=X, templates=Y, dailyLimit=40"*.
3. Backend saves the job to a database + queue.
4. **4 cloud worker machines** each pick up one profile and start driving it (Chromium runs on cloud infra, not on Antonio's Mac).
5. Antonio closes his MacBook and goes home.
6. Campaigns keep running on the workers — leads get sent, sheet gets updated.
7. Next morning Antonio opens his Mac → dashboard syncs with the server → shows him *"160/160 done, here's what happened"*.

Meanwhile **Milena** does the same thing with her 5 profiles. Her jobs land on 5 different workers in the same shared pool. She sees only her campaigns; Antonio sees only his.

### "Multi-tenant" = shared infrastructure, walled-off views

Imagine one office building with 100 private offices. Everyone uses the same building (same backend, same worker pool, same database), but each office is locked. Every cloud request carries an auth token; the server uses it to return only that user's data.

In practice:
- **One** backend deployment serves all 100 colleagues (not 100 separate copies).
- Each user's templates / sheets / campaign history are isolated by user ID in the database.
- Admin view (Antonio + boss) can see the whole fleet; regular users see only themselves.

### What stays identical for each colleague

- Install the Electron `.dmg` on their Mac (same as today)
- Log in with their Ortus email (existing `src/auth.js`)
- Dashboard, templates, Preview Messages button, campaigns — all look identical
- GoLogin profiles + Google Sheets work exactly as before
- LinkedIn sees the same residential proxy per profile (proxy binding unaffected by host change)

### What's new on the cloud side (three components to build)

1. **Central database** — Postgres (or similar). Stores user accounts, templates, campaign jobs, history, schedules. Replaces today's local files (`data/state.json`, `data/templates.json`, etc.).
2. **Job queue + worker pool** — BullMQ / Redis or SQS. Mac submits campaigns → queue → 20–60 worker processes pull jobs → execute using the existing `src/campaign.js` logic largely unchanged.
3. **Worker autoscaling** — 3 people on a Saturday = 3 workers. 30 people Tuesday morning = 30+ workers. Pay for actual usage, not peak-sized infra sitting idle.

## Cost model

| Scenario | Cost (rough) |
|---|---|
| Sleepy Saturday, 3 people running | ~€10 that day |
| Busy Tuesday, 30 people running | ~€30 that day |
| **Monthly estimate at expected usage** | **€400–600/mo** of cloud infra, scales with demand |
| Compare: 100 always-on VMs (alternative) | €700/mo minimum, regardless of usage |

Math basis: ~€0.10 per browser-hour × ~1000 weekly browser-hours across 100 colleagues averaging 10 hours/week.

## Scope estimate

**~4–8 weeks of focused work** for a minimum viable version:
- Multi-tenant auth (extend `src/auth.js`)
- Postgres schema for users, templates, campaigns, history
- Job queue + worker process
- Worker pool deployment (Docker + autoscaling on Hetzner / DigitalOcean / similar)
- Migration path from current local app to cloud-backed app
- Observability (logs, alerts, dashboard for admin)

vs. the **1–2 days** the original "just put it on a VM" was estimated at.

This is a real project. Becomes something someone owns indefinitely.

## The message drafted for the boss

Ready to send. Tweak `[boss]` placeholder.

---

> Hey [boss] — I looked into running the GoLogin accounts on a VM as you suggested, and did some deeper thinking on what it would take at 100-colleague scale. Flagging a few things before I write more code.
>
> ### Why "just put it on a VM" doesn't work for us
>
> **1. A VM is essentially a second computer — only one person can use it at a time.** If Antonio is running 4 campaigns on VM_17, that VM is now fully occupied. If Milena wants to run her 5 campaigns, she can't — the VM is busy. We'd either have to wait, or give her a different VM. With 100 colleagues potentially running campaigns concurrently, we'd need roughly one VM per active user. That's expensive and quickly becomes a mess to manage.
>
> **2. Putting the tool on a VM doesn't solve campaigns running overnight.** As long as the campaign *controller* still runs on each colleague's MacBook (even if the browsers are on the VM), closing the laptop kills the campaign. The laptop still has to stay open.
>
> **3. GoLogin's own paid Cloud Launcher service** (the obvious paid shortcut) has the same limitation — browsers move to their infrastructure, but each colleague's laptop still has to stay on to orchestrate. Plus per-hour fees (~$500–2,000/mo at our scale). Paying for it would not solve our real problem, so it would just be wasted budget.
>
> ### What we actually need: a proper cloud version of our tool
>
> Since we've committed to owning this ourselves rather than paying for third-party outreach tools, here's what that looks like in plain terms.
>
> **Today**, each colleague's Mac does everything — serves the dashboard, stores templates, launches browsers, drives LinkedIn. Every Mac is an island.
>
> **In the cloud version**, we split the tool into two halves:
>
> - **Each person's Mac** still has the Electron app, but it becomes a "remote control". It shows the dashboard, the templates, the Preview button, the Start button. That's all.
> - **A central cloud backend** does the actual work. When Antonio clicks Start, his Mac sends a small message to the backend: *"run these 4 profiles"*. The backend runs his campaigns on a shared pool of cloud worker machines. When Milena does the same, her 5 profiles go to different workers in that same pool. The pool scales up and down with real demand. One backend serves all 100 colleagues, but each person only sees their own campaigns, history, and templates — walled off by user account.
>
> ### Benefits this unlocks
>
> - **Antonio closes his MacBook → campaigns keep running** on the cloud workers. Same for everyone.
> - **No RAM burden on anyone's laptop** — the browsers don't live there anymore.
> - **No "which VM is free?" conflicts** — the workers are a shared pool, not individually assigned machines.
> - **Each colleague has their own private view**; you and I (as admins) can oversee the whole fleet.
>
> ### What each colleague still experiences
>
> - Installs the Electron `.dmg` on their Mac (same as today)
> - Logs in with their Ortus email (same)
> - Dashboard, templates, Preview Messages button, campaigns — all look identical
> - GoLogin profiles and Google Sheets work exactly as before
>
> ### Cost model
>
> You pay for **actual usage**, not 100 always-on machines:
> - Sleepy Saturday with 3 people running: ~€10 that day
> - Busy Tuesday morning with 30 people running: ~€30 that day
> - Rough monthly estimate at our expected usage: **€400–600/mo** of cloud infrastructure, scaling with demand
>
> Compare to giving each colleague their own dedicated VM (which would be needed because of problem #1 above): roughly 100 × €7/mo = **€700/mo minimum**, regardless of whether anyone's actually running campaigns.
>
> ### Scope
>
> **~4–8 weeks of focused work** to ship a minimum viable version (multi-tenant backend, job queue, worker pool, auth, database for per-user state) — vs. the 1–2 day "just put it on a VM" originally in mind.
>
> Worth aligning on this scope shift before I write any more code. Happy to write it up as a proper proposal doc if you want to circulate it.

---

## Open decisions before any code is written

1. **Boss alignment** — does he agree with the scope shift? Or does he want to push back / explore Path 1 (GoLogin Cloud Launcher) again?
2. **Realism check on scale** — is "100 colleagues with concurrent campaigns" the *actual current* situation, or a *future* ceiling? If only 5–10 active operators today, an interim Path 1 might still make sense as a stepping stone. **This question affects the whole plan.**
3. **Hosting choice** — Hetzner Cloud (cheapest, EU-only) vs DigitalOcean (more polished UX, ~5× more expensive) vs AWS/GCP (most expensive, most flexible). Linux VM research file recommends Hetzner CCX13 / CX32 for the single-VM case; for the worker pool case, would need to re-spec.
4. **Migration strategy** — do existing operators migrate atomically (dashboard switches over on a single day), or do we run cloud-backed and local-backed versions in parallel for a transition period?
5. **Who owns this long-term** — once shipped, this is infrastructure that needs babysitting (Postgres backups, worker health, incident response). Need to identify the owner.

## When picking up in a future session

Tell the agent: *"Read CLOUD-SAAS-PLAN.md and continue."*

Most likely next steps depending on boss's response:
- **Boss approves scope** → spec out the database schema + job queue contract (small upfront design doc), THEN start a phased build plan in `.planning/phases/`.
- **Boss wants quicker ROI** → scope a Path 1 (GoLogin Cloud Launcher) interim version that solves *just* the RAM problem for current users, while the full SaaS is built in parallel.
- **Boss wants a proposal doc** → expand this MD into a formal proposal with timeline, milestones, and a decision matrix for circulation to leadership.

## Out of scope for this plan

- Don't migrate the Chrome extension (`~/Downloads/ortus-connection-checker*`) into this work — separate concern, has its own MD (`EXTENSION-CONNECT-BUTTON-FIX.md`).
- Don't touch `src/linkedin/outreach.js` or `src/linkedin/actions.js` — they're flagged off-limits in `CLAUDE.md`. The cloud workers will reuse them as-is.
- Don't break the existing local Electron app while the cloud version is being built. Operators using 2.8.x today must continue to be able to run campaigns locally until cloud is fully shipped and proven.
