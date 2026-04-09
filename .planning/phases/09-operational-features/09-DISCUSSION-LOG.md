# Phase 9: Operational Features - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.

**Date:** 2026-04-09
**Phase:** 09-operational-features
**Areas discussed:** Scheduling approach, Rate-limit strategy, History & CSV format

---

## Scheduling Approach

| Option | Description | Selected |
|--------|-------------|----------|
| node-cron (Recommended) | In-process cron via npm package. Dashboard config. | ✓ |
| Simple interval timer | setInterval-based, less flexible | |
| You decide | Claude picks | |

**User's choice:** node-cron

| Option | Description | Selected |
|--------|-------------|----------|
| Dashboard UI (Recommended) | Operator sets schedule in dashboard, saved to JSON | ✓ |
| Config file only | Manual JSON file editing | |

**User's choice:** Dashboard UI

---

## Rate-Limit Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Expand existing limit | Keep dailyLimit, add configurable min/max delay | |
| Full rate config | Daily + hourly + full delay controls | |
| You decide | Claude picks balance | ✓ |

**User's choice:** You decide
**Claude's decision:** Configurable min/max delay (default 8-15s) + existing dailyLimit. No hourly cap. Randomized delays are the key safety feature.

---

## History & CSV Format

| Option | Description | Selected |
|--------|-------------|----------|
| Summary per campaign | Date, mode, profiles, counts, duration per campaign | ✓ |
| Full logs + summary | Everything plus full log lines | |
| You decide | Claude picks | |

**User's choice:** Summary per campaign

| Option | Description | Selected |
|--------|-------------|----------|
| Lead-level detail | One row per lead with URL, name, action, result, profile, timestamp | ✓ |
| Campaign summary | One row per campaign run | |
| You decide | Claude picks | |

**User's choice:** Lead-level detail

---

## Claude's Discretion

- node-cron version, schedule ID generation, "run now" button, CSV column ordering

## Deferred Ideas

None
