# Basics improvements transferred to Outreach

Source: Ortus Basics 1.7.56 (`aa4f3aa`). Target: Outreach 3.1.60.14 (`4cdf45f`), branch `sam/outreach-basics-improvements`.

This is a local Electron preview, not a published release or cloud engine deployment.

## Applied

- Permanent local campaign UUIDs across drafts, saved settings, queues, schedules, history, and restart snapshots. Legacy records are backed up before migration. Renaming keeps the ID; duplicating creates a distinct campaign. The editor displays its campaign ID.
- Campaign-specific wizard memory, saved messages/accounts/channel choice, duplicate-name feedback, and isolated live-status cards. Save remains in the editor. Opening a local campaign uses its own settings instead of a cloud lookup.
- Scheduling retains the full launch configuration, replaces an existing schedule for the same campaign, displays scheduled runs, and queues a due local campaign while another is running.
- GoLogin Settings for built-in and custom workspaces: add, replace, remove, masked status, local storage with owner-only file permissions, atomic writes, and immediate cache invalidation. Persisted replacements/removals override old defaults after restart. Custom workspace IDs remain stable when another workspace is removed.
- Each workspace shows Connected, Error (with its own reason), or Not checked. Verdicts apply only to the exact token checked. A broken workspace no longer hides profiles from working workspaces.
- Token saving reports a separate connectivity result. Read-only validation identifies rejection, rate limiting, timeout, and connection failure. Account-list refresh ends with a count and Done or an explicit failure. Check connection retries saved tokens. No stored token is returned to password fields.
- Paste an account list to select matching profiles; local bench/remove/retry controls; clearer login and suspected-credit-limit states.
- Immediate per-account daily and batch counters, explicit UTC daily reset expressed in local time, and an actual daily cap for Message campaigns.
- LinkedIn subject text retained, actual sent-via metadata, Sales Navigator subscription-gate fallback, persistent missing-licence status, and explicit retry. Unconfirmed sends remain unconfirmed.
- Connection-only and optional connection-note controls, primary-not-connected explanations, improved acceptance matching, manual check progress and stop controls. Stop-window options are opt-in and currently local-only.
- Nonblocking tracked sheet writes with a bounded pending set and final drain; clearer sheet errors; API responses are not cached.
- App update installation now requests a full Electron quit and retries relaunch correctly.
- Ordinary operators' cloud board responses and campaign detail/control requests are scoped by ownership. The scrape board hides other operators' rows. Admins retain the team view.

## Outreach behavior retained

Cloud campaigns, local/VM switching, cloud resume and read-only live views, all original campaign modes, workspace mode restrictions and State of Operations rules, automatic acceptance monitoring, and primary handshake flows remain available. Basics' disabled login/cloud/monitoring paths were not carried across.

The preview continues to use Outreach's existing engine and Sheets endpoint. The new Sheets bridge code and Sent via payload are present, but an older deployed bridge/engine will need compatible deployment to show that column for everyone. Basics' gateway was not substituted because its approved workspace tokens and ownership differ. No infrastructure or production release changed.

The extra connections-only and timed-stop flags are refused on a cloud launch until its engine supports them. Local settings get permanent IDs; cloud records retain their existing engine IDs.

## Verification

- Full Node suite: 2,887 passed, zero failed, two skipped (local HTTP listeners permitted, fixed locale). Additional cloud-option compatibility checks also pass.
- Electron smoke checks use intercepted HTTP and synthetic tokens: success, rejected token, and account-list failure all reach a final state and re-enable controls. No credentials are captured or printed.
- Actual local preview API/editor checks: two saved campaigns retain different messages and channel settings; rename preserves the ID; reload preserves the message. Temporary test records are removed.
- Preview identity remains non-admin. No test campaign was launched and no test outreach message was sent.

Tests that depend on the remotely deployed engine or actual LinkedIn sending remain outside these local checks. Production publishing should use a separately reviewed version increment and release.

Saved workspace tokens now grant cross-team profile selection and launch access on this installation. Bundled tokens retain their domain rules. Removing the saved token revokes the additional access. Campaign ownership visibility remains separate.

## GoLogin-only browser selection

Removed Local Browser from campaign accounts, primary-person source selection, follower-growth pairing and send accounts, and the old follow-up login action. Restored campaign selections discard the retired sender; legacy API requests and campaign starts reject it with an instruction to choose GoLogin. The local Chrome launcher is disabled, including calls from old background tasks. GoLogin profiles can still run on this Mac.

Validation: 2,890 tests passed, zero failures, two skipped. Electron UI checks with a synthetic GoLogin profile found no Local Browser selector, confirmed the GoLogin primary default, and found no renderer errors. No campaign was started.
