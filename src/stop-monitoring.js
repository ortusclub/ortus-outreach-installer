/**
 * Helpers for ending a Monitoring-phase campaign — either operator-triggered
 * via the "Stop monitoring" button, or auto-triggered at T+7d.
 *
 * Still-pending lead = a row that had a connection request sent but never
 * flipped to Connection Accepted. These get stamped Closed - Not Connected
 * in the sheet so they don't get processed again.
 */

export const CLOSED_NOT_CONNECTED_STAMP = 'Closed - Not Connected';

/**
 * @param {Array<object>} rows  Sheet rows (output of fetchSheet)
 * @param {string} linkedinColumn  Header name for the LinkedIn URL column
 * @returns {Array<string>}  URLs that need the Closed-Not-Connected stamp
 */
export function computeStillPendingUrls(rows, linkedinColumn) {
  const out = [];
  for (const r of rows || []) {
    const url = r[linkedinColumn];
    if (!url) continue;
    const sent = (r['Connection Request Status'] || '').toString().toLowerCase();
    const accepted = (r['Connection Accepted Status'] || '').toString().toLowerCase();
    if (sent.includes('connection request sent') && !accepted.includes('connected')) {
      out.push(url);
    }
  }
  return out;
}

export function buildClosedNotConnectedUpdate() {
  return { connectionRequestStatus: CLOSED_NOT_CONNECTED_STAMP };
}
