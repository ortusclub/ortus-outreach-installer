# Ortus Outreach 3.0

The first major release since 2.120. Campaigns now run on our own cloud infrastructure rather than on your machine, Follower Growth has been rebuilt as a complete workflow, and the Sales Navigator scraper has a shared team board.

---

## Campaigns run in the cloud

Campaigns execute on a dedicated cloud VM instead of your laptop. Start a campaign, close your machine, and it continues sending. Reopening the app reattaches to the run in progress.

Campaigns can also be scheduled to start later, held by the VM. Your machine does not need to be awake.

## Full visibility while a campaign runs

The live status card names the specific person being actioned rather than showing a generic progress state. Each account appears with its own status: invites sent, or the reason it stopped — no credits, logged out, weekly cap reached, or an error — with the full explanation available on hover.

A stalled campaign now explains the cause and the available remedy. An account at LinkedIn's weekly invitation cap reports the date it resets rather than offering a retry that cannot succeed.

## Follower Growth

Follower Growth is now a reviewed workflow: select the roles to target, the application builds the invite list into a dedicated Google Sheet tab, you review and edit it, then launch. Nothing is sent before someone has approved the list.

- **Auto-Pilot** runs the campaign automatically on the 1st and 15th of each month at 06:00. It generates the invite list three days in advance and notifies you that it is ready for review.
- **FG Master** consolidates the entire warm network into a single sheet tab, built incrementally, with the team's manual funnel data merged in.
- Role matching now covers the full marketing vocabulary — approximately 50,000 contacts.
- A completed run reports why it stopped short of its target.

## Sales Navigator scraper

All operators' scrapes appear on one shared board, giving visibility across the team rather than only your own jobs. Scrapes can be configured inline without leaving the board, paused and resumed at any point, and each has a persistent operator log that survives the run.

## Reply checking

Reads the Sales Navigator inbox for Open Profile and InMail replies, with per-account live status and the full message body in a reading pane. Any thread can be opened directly in the correct GoLogin browser profile.

## GoLogin workspaces

Three workspaces are now supported, including Marketing. Marketing accounts are available to all operators but restricted to Follower Growth and Post Amplification, so they cannot be used for other campaign types.

## Reporting

The Follower Growth sheet — Run Health, FG Budgets, and each run's invite list — is now colour-coded and formatted: green for sent, amber for partial or pending, red for failed or out of credits, with proper headers and date formatting.

## Additional changes

- Post Amplification is now available
- Local and VM execution are selected by tabs at the top of the campaign setup, replacing the checkbox in the Launch step
- Sheet write-back from cloud campaigns matches local execution exactly
- The identity safeguard setting is correctly applied to cloud runs
- The Check Status campaign type has been retired; the acceptance sweep used by Connect + Introduce is unaffected
- The warm-up step has been removed

---

## Installation

Download the appropriate disk image from the release page:

- **Ortus-Outreach-arm64.dmg** — Apple Silicon (M1 and later)
- **Ortus-Outreach-intel.dmg** — Intel Macs

Drag the application to Applications, replacing the existing version. On first launch, right-click the application and select Open to bypass the Gatekeeper warning, as the build is unsigned.

Please report any issues with a screenshot.
