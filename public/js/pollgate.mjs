// Whether the dashboard should keep polling /api/campaign/status.
//
// A monitoring campaign is NOT `running`, so the original gate
// (`if (__cockpit.running) startPolling()`) started the interval for a sending
// campaign and never for a monitoring one. The card then rendered once at page
// load and froze, which is indistinguishable from a hung app: pressing "Run
// check now" appeared to do nothing for the whole sweep.
//
// The matching STOP gate in app.js already excluded monitoring correctly; only
// the start side was wrong.
export function shouldPoll(status) {
  if (!status) return false;
  return !!status.running || status.state === 'monitoring';
}
