# Moving the LinkedIn Outreach Tool to the Cloud

**Decision memo — April 2026**

---

## The problem we're solving

Today the LinkedIn outreach system runs on a team member's Mac. That means:

- Campaigns stop if the laptop sleeps, loses wifi, or closes.
- Long campaigns hold a lot of RAM on a personal machine (roughly 1 GB per active account).
- Only whoever owns that Mac can launch a run.
- Scheduled weekend / overnight runs aren't possible unless someone leaves a machine open.

We want the tool to run **independently of any personal computer** — start a campaign, close the laptop, walk away.

---

## Three ways to do this

### Option 1 — GoLogin's built-in Cloud Launcher
GoLogin (the service we already use for the LinkedIn accounts) offers a paid "Cloud Browser" feature. Each account runs on their servers instead of our Mac. Our dashboard talks to it over the internet, exactly the same way it talks to a local browser today.

**What we get**
- Zero setup. No servers to manage.
- Each LinkedIn account keeps using its own proxy / IP, so LinkedIn sees no change in login location. This is the critical safety point — moving to the cloud does **not** trigger security checks.
- Mac can be fully shut down.

**What it costs**
- An add-on to our current GoLogin plan. Pricing is roughly **$0.05–0.20 per account per hour** of actual campaign time, or bundled into a higher plan tier.
- For our typical usage (5 accounts × 2 hours/day × 22 days) this sits around **$20–80 / month**.
- Plus a small $5–10/month cloud host for the dashboard itself.

**Total estimated monthly cost: $25–90.**

---

### Option 2 — Self-hosted virtual machine (DIY)
Rent a small Linux server (Hetzner, DigitalOcean) for a fixed monthly fee, install GoLogin and our tool there, and run everything on that server.

**What we get**
- Flat monthly cost, no per-hour billing. Same tool, same campaigns.
- More control — can add backups, monitoring, scheduled campaigns.
- Mac can be shut down.

**What it costs**
- **€12–20 / month** fixed for the server. That's it.

**The catch**
- It's a one-time **setup lift of 1–2 days** for someone technical. After that it runs itself.
- If something breaks (Linux update, GoLogin software change), someone has to go fix it.
- We'd be signing up for low-level server maintenance responsibilities.

**Total estimated monthly cost: €12–20.**

---

### Option 3 — Stay on the Mac (status quo)
Leave the tool on a dedicated Mac that stays on and open 24/7.

**What we get**
- No migration work.
- No new bills.

**What it costs in practice**
- A Mac permanently tied up as a "server." Can't use it for anything else.
- Manual babysitting — someone has to confirm it's still running, wifi hasn't dropped, etc.
- No team-wide access.

---

## Recommendation

**Start with Option 1 (GoLogin Cloud Launcher).**

Why:
1. **Lowest risk of breaking what works.** Keeps our existing setup, same code, same accounts, same proxies. LinkedIn sees the same login pattern it always has.
2. **Fastest to ship.** No infrastructure skills required. We can trial it with one account for a week before committing the whole fleet.
3. **Predictable upgrade path.** If per-hour costs grow beyond €80/month once usage scales, switching to Option 2 is straightforward — same codebase, just a different host.

Option 2 is the right answer if GoLogin's Cloud pricing doesn't fit the budget, or if we want long-term ownership of the infrastructure. But it introduces ongoing maintenance that's currently no one's job.

---

## What we need from you to move forward

1. **Budget approval**: a ceiling for monthly cloud costs (recommend **up to €100/month** for Option 1).
2. **Decision on Option 1 vs Option 2**: if the recommended path (Option 1) is OK.
3. **GoLogin plan check**: confirm the current plan allows Cloud Launcher — if not, we may need to upgrade the GoLogin subscription.
4. **Trial approval**: permission to pilot the move on **one account** for one week, measure real cost, then scale to the fleet.

---

## Timeline if approved

| Step | Duration |
|---|---|
| GoLogin plan check + Cloud Launcher enablement | 1 day |
| Code change to switch one account to cloud mode | 1 day |
| Pilot run (1 account, 1 week) | 7 days |
| Measure cost, compare with estimate | 1 day |
| Roll out to the full fleet | 1 day |

**Total time to full migration: about 2 weeks, most of which is the pilot.**

---

*Prepared by Antonio Varlese — Ortus Club*
