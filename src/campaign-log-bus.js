/**
 * Cross-module bus for routing scheduled-job log lines back into a live
 * campaign's in-memory log array. Used by the Monitoring Phase: the
 * post-campaign scheduler runs after the active sending phase ends, but
 * the in-memory `campaign` object stays alive for the 7-day Monitoring
 * window. campaign.js registers an appender per (sheet, profile); the
 * scheduler calls `appendCampaignLog` to forward its status lines.
 *
 * Avoids a circular import: post-campaign-bulk-check.js → campaign.js
 * would loop because campaign.js already imports registerSchedule from
 * post-campaign-bulk-check.js.
 */

const _appenders = new Map(); // key = sheetId|profileId → function(line)

function _k(sheetId, profileId) { return `${sheetId}|${profileId}`; }

export function registerAppender(sheetId, profileId, appender) {
  if (typeof appender !== 'function') return;
  _appenders.set(_k(sheetId, profileId), appender);
}

export function unregisterAppender(sheetId, profileId) {
  _appenders.delete(_k(sheetId, profileId));
}

export function clearAllAppenders() {
  _appenders.clear();
}

export function appendCampaignLog(sheetId, profileId, line) {
  const a = _appenders.get(_k(sheetId, profileId));
  if (a) {
    try { a(line); } catch { /* swallow — must not break scheduler */ }
  }
}

/**
 * Factory: returns an appender bound to the given logs array, prefixing
 * each line with an ISO timestamp and enforcing a ring-buffer cap.
 */
export function buildAppendLogger({ logs, capLines = 5000 }) {
  return function appendLog(line) {
    if (!Array.isArray(logs)) return;
    const ts = `[${new Date().toISOString()}]`;
    logs.push(`${ts} ${line}`);
    while (logs.length > capLines) logs.shift();
  };
}
