# Engine-side spec: primary-handshake hard-lock (Phase 0)

**Audience:** whoever owns / deploys the engine at `https://scraper.ortusclub.com`.

**Goal:** let a cloud **CC+IC / CC+DM** campaign whose **primary is local-only**
complete the "sender ↔ primary" connection before it starts outreach — by sending the
connect-requests on the VM, then **pausing** so the operator's Mac can accept them as
the local primary, then resuming to run 100% on the VM.

This is the third engine handoff alongside `cloud-engine-needs-login-spec.md` and
`cloud-engine-campaign-view-spec.md`.

---

## Why the engine has to do this

The accept-as-primary physically cannot run on the VM (no operator Chrome), and the
primary is often logged in only on the operator's Mac. So the **Mac does the accept**,
but the campaign must not start outreach until the senders are connected to the
primary. The engine already receives everything it needs in `config` (spread from the
app's templates): `autoAcceptPrimary`, `autoAcceptAllPending`, `primarySource`,
`primaryName`, `primaryUrl`. The trigger is:

```
autoAcceptPrimary === true  &&  primarySource === 'local-browser'
```

When that holds, run the handshake below. (If `primarySource` is a GoLogin profileId,
the engine can drive that profile to accept itself — no Mac, no pause — but that path
is out of scope here.)

## Phase 0 — before any lead outreach

For each sender account in the campaign, open its GoLogin session and send a single
**connect-request to the primary** (`primaryUrl`), unless already connected. Record
each sender's own LinkedIn identity (name + profile URL) — you already have the
session open; this is what the Mac matches to accept the right invitations.

Then enter the paused state and **do not start lead outreach**.

## The paused state — exposed on `GET /api/campaign/:id`

```jsonc
{
  "id": "cmp_…",
  "state": "awaiting_primary_accept",     // NEW terminal-until-resumed state
  "primary": { "name": "Antonio Varlese", "url": "https://www.linkedin.com/in/antoniovarlese/" },
  "senders": [
    { "profileId": "gl_abc", "name": "Alex Sheeraz", "url": "https://…", "accepted": false },
    { "profileId": "gl_def", "name": "Marco Rossi",  "url": "https://…", "accepted": true  }
    // …one per sender that sent the primary a request
  ],
  "acceptAllPending": true                 // echo of autoAcceptAllPending, for the app's info
}
```

- `state` must be a value the app can detect (it polls this endpoint already).
- `senders[].name/url` are what the Mac matches — without them the Mac can only
  accept-all-pending, which is less safe.
- `accepted` may start all-false; the app re-reads to show progress, but the app is
  the one doing the accepting, so the engine mainly needs to expose the *list*.

## Resume — `POST /api/campaign/:id/primary-accept-done`

```
POST /api/campaign/:id/primary-accept-done
Authorization: Bearer <token>
Body: { "accepted": ["gl_abc", "gl_def", …] }   // sender profileIds the Mac accepted
→ 200 application/json { ok: true, state: "running" }
→ 409 application/json { ok: false, error: "not awaiting accept" }
```

**Do not blindly trust the signal.** Before releasing the lock, **re-verify
server-side** that at least the reported senders are now connected to the primary
(re-check one sender ↔ primary connection using that sender's session — the engine can
do this, the Mac cannot see the VM's sessions). Only then set `state: 'running'` and
begin lead outreach. This protects against a false "done" stranding real outreach on a
half-built primary.

## Idempotency & edge cases

- **Repeated Phase 0** (retry / restart) must not re-send a connect-request to a
  primary the sender is already connected to, and must not double-count.
- **Duplicate done-signal** after resume → `409`, no state change.
- **Partial accept:** if the app signals only some senders, you may resume with those
  and keep the rest pending, OR stay locked until all are in — either is acceptable;
  document which. Recommended: resume when ≥1 sender is verified-connected so a single
  stuck sender doesn't block the whole campaign, and let the auto-check loop pick up
  the stragglers.
- **Never start outreach** while `state === 'awaiting_primary_accept'`.

## App side — already designed / partly built

- The app polls `GET /api/campaign/:id`, detects `awaiting_primary_accept`, opens the
  **local primary browser**, accepts exactly the reported senders (matched by
  name/url; plus accept-all-pending iff `acceptAllPending`), then POSTs
  `primary-accept-done`. Reuses the local `primary-task-runner` + `acceptInvitationFrom`.
- UI shows a hard-lock waiting state (inline panel + one-time modal) that flips to
  "Running" on release. Sketch:
  `public/sketches/2026-07-10-cloud-primary-handshake-lock.html`.
- The follow-up (which also acts as the primary) is disabled app-side for this
  configuration, so the engine does **not** need to run any primary-side follow-up for
  a local-only primary.

## Acceptance test

1. Start a cloud CC+IC campaign with `autoAcceptPrimary=true`,
   `primarySource='local-browser'`, 3 GoLogin senders.
2. Engine sends 3 connect-requests to the primary, then `GET /api/campaign/:id`
   returns `state:"awaiting_primary_accept"` with 3 `senders`.
3. `POST /primary-accept-done` with the 3 ids → engine re-verifies → `state:"running"`
   and lead outreach begins.
4. No lead receives anything before step 3.
