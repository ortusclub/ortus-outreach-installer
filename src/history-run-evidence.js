export function runLogSlice(lines, entry) {
  const end = Date.parse(entry.date || '');
  if (!Number.isFinite(end)) return [];
  const starts = [];
  lines.forEach((line, index) => {
    if (/=== Campaign starting ===/.test(line)) {
      const time = Date.parse(line.match(/^\[([^\]]+)\]/)?.[1] || '');
      if (Number.isFinite(time)) starts.push({ index, time });
    }
  });
  const candidates = starts.filter((start, i) => start.time <= end && (!starts[i + 1] || starts[i + 1].time > end));
  if (candidates.length !== 1) return [];
  const start = candidates[0];
  const expectedStart = Date.parse(entry.startedAt || '') || end - Number(entry.duration || 0) * 1000;
  // Match a recorded run boundary, not the neighbouring run's grace window.
  if (!Number.isFinite(expectedStart) || Math.abs(start.time - expectedStart) > 15000) return [];
  const next = starts.find(s => s.index > start.index);
  const run = lines.slice(start.index, next?.index ?? lines.length);
  const ended = run.findIndex(line => /=== Campaign ended ===/.test(line));
  return ended >= 0 ? run.slice(0, ended + 1) : run.filter(line => {
    const time = Date.parse(line.match(/^\[([^\]]+)\]/)?.[1] || '');
    return Number.isFinite(time) && time <= end;
  });
}

export function historyFacts(entry, lines = []) {
  const loggedTotal = lines.map(line => line.match(/Pre-filter → (\d+) to process/)).find(Boolean);
  const totalTargets = entry.totalTargets ?? (loggedTotal ? Number(loggedTotal[1]) : null);
  const notice = entry.debrief?.endNotice || entry.endNotice;
  const uncertain = (entry.debrief?.skips || []).some(s => /429|unconfirmed|not confirmed|confirming|uncertain/i.test(s.detail || ''));
  const endReason = entry.endReason === 'stopped' || entry.fullStop ? 'stopped'
    : ['errored', 'failed'].includes(entry.endReason) ? entry.endReason
    : notice?.reason === 'all_parked' ? 'blocked'
    : uncertain || Number(entry.errorCount) > 0 ? 'needs_review'
    : entry.endReason;
  return { totalTargets, endReason, endNotice: notice || null, needsOutcomeReview: uncertain || Number(entry.errorCount) > 0 };
}
