// src/resume-diff.js
// Pure helpers for the "resume picks up live state" review summary. No I/O, no DOM.
// The server computes the resumeChanges object from these and returns it; the client
// only renders it. Single source of truth so the preview can't drift from what's applied.

function normUrl(u) {
  return String(u || '').trim().toLowerCase().split('?')[0].replace(/\/+$/, '');
}

/**
 * Diff the re-fetched + re-filtered lead rows against the rows currently in the run.
 * Identity = normalized LinkedIn URL (via the caller-supplied urlOf, so we reuse the
 * real extractLinkedInUrl at the call site and keep this module pure).
 * Already-sent leads are excluded upstream by the existing filter, so they never appear.
 */
export function computeSheetDiff(prevTargets, newTargets, urlOf) {
  const prevByUrl = new Map();
  for (const row of prevTargets || []) {
    const u = normUrl(urlOf(row));
    if (u) prevByUrl.set(u, row);
  }
  const added = [];
  const updatedPending = [];
  for (const row of newTargets || []) {
    const u = normUrl(urlOf(row));
    if (!u) continue;
    if (!prevByUrl.has(u)) {
      added.push(row);
    } else {
      const prev = prevByUrl.get(u);
      // Stable, key-order-independent serialization for change detection: sort keys (sheet
      // rows can come back with shifted key order between fetches) and normalize the URL
      // field so case/query/trailing-slash noise isn't mistaken for a content change. Only
      // a field whose value equals this row's raw URL is normalized — anything else is a
      // real edit to a personalization variable.
      const canon = (r) => {
        const rawUrl = urlOf(r);
        return JSON.stringify(
          Object.keys(r).sort().map((k) => [k, r[k] === rawUrl ? u : r[k]]),
        );
      };
      if (canon(row) !== canon(prev)) {
        updatedPending.push(row);
      }
    }
  }
  return {
    added,
    updatedPending,
    addedCount: added.length,
    updatedCount: updatedPending.length,
    newTotal: (newTargets || []).length,
  };
}
