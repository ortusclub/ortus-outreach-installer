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

/**
 * Diff the account set. prev/next: { ids: string[], benched: string[], names: {id:name} }.
 * We never hard-remove accounts in v1 (bench instead), but `removed` is computed for safety.
 */
export function computeAccountDiff(prev, next) {
  const nameOf = (id) => (next.names && next.names[id]) || (prev.names && prev.names[id]) || id;
  const prevIds = new Set(prev.ids || []);
  const nextIds = new Set(next.ids || []);
  const prevBench = new Set(prev.benched || []);
  const nextBench = new Set(next.benched || []);
  const toEntry = (id) => ({ id, name: nameOf(id) });
  return {
    added: [...nextIds].filter(id => !prevIds.has(id)).map(toEntry),
    removed: [...prevIds].filter(id => !nextIds.has(id)).map(toEntry),
    benched: [...nextBench].filter(id => !prevBench.has(id) && nextIds.has(id)).map(toEntry),
    reEnabled: [...prevBench].filter(id => !nextBench.has(id) && nextIds.has(id)).map(toEntry),
  };
}

/**
 * Diff campaign settings the existing paused editors mutate. snap = pause-time snapshot,
 * cur = current live values. Read-only over existing state.
 */
export function computeSettingsDiff(snap, cur) {
  const out = [];
  if (snap.dailyLimit !== cur.dailyLimit) {
    out.push({ key: 'dailyLimit', label: 'Daily limit', from: snap.dailyLimit, to: cur.dailyLimit });
  }
  if (snap.checkIntervalMinutes !== cur.checkIntervalMinutes) {
    out.push({ key: 'cadence', label: 'Check cadence', from: snap.checkIntervalMinutes, to: cur.checkIntervalMinutes });
  }
  if (JSON.stringify(snap.templates || {}) !== JSON.stringify(cur.templates || {})) {
    out.push({ key: 'templates', label: 'Message / intro text', changed: true });
  }
  return out;
}

/** Assemble the resumeChanges object the API returns and the UI renders. */
export function summarizeResumeChanges({ sheetDiff, accountDiff, settingsDiff }) {
  const acct = accountDiff || { added: [], removed: [], benched: [], reEnabled: [] };
  const settings = settingsDiff || [];
  const accountChanged = !!(acct.added.length || acct.removed.length || acct.benched.length || acct.reEnabled.length);
  const sheetChanged = !!(sheetDiff && (sheetDiff.addedCount || sheetDiff.updatedCount));
  return {
    sheet: sheetDiff || { added: [], updatedPending: [], addedCount: 0, updatedCount: 0, newTotal: 0 },
    accounts: acct,
    settings,
    isEmpty: !sheetChanged && !accountChanged && settings.length === 0,
  };
}
