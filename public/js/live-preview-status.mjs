export function previewStatus(data, fallback = 'Campaign', now = Date.now()) {
  const c = data.campaign || {};
  const state = c.status || 'unknown';
  const terminal = { done: 'Campaign complete', completed: 'Campaign complete', cancelled: 'Campaign stopped', stopped: 'Campaign stopped', failed: 'Campaign failed', needs_review: 'Needs attention', paused: 'Campaign paused' };
  const logs = (Array.isArray(data.monitorLog) ? data.monitorLog : []).map(e => ({ line: String(e.line || ''), t: Number(e.t) || 0 })).filter(e => e.line).sort((a,b) => b.t-a.t).slice(0,5);
  const due = terminal[state] ? 0 : [c.blocked_until, c.scheduled_start_at, c.resumeTaskDueAt, c.monitorTaskDueAt, c.next_check_at].map(v => v ? new Date(v).getTime() : 0).filter(t => t > now).sort((a,b) => a-b)[0] || 0;
  const step = terminal[state] || (due ? 'Waiting for the next scheduled action' : data.liveProgress?.stepLabel || ({ queued: 'Waiting for a worker', scheduled: 'Scheduled', monitoring: 'Monitoring connections', sending: 'Waiting for the next account turn', running: 'Campaign running' }[state]) || 'Waiting for an engine update');
  const next = terminal[state] ? (['done','completed','cancelled','stopped'].includes(state) ? 'No further browser activity is scheduled for this run.' : 'Open the campaign to review its status before continuing.') : due ? 'The engine will retry or run its next check at the time below.' : 'The browser preview will appear automatically when a browser becomes available.';
  return { name: c.name || fallback, step, next, due, logs, terminal: !!terminal[state] };
}
export function countdown(due, now = Date.now()) {
  if (!due) return '';
  const seconds = Math.ceil((due - now)/1000);
  if (seconds <= 0) return 'Due now · waiting for the engine';
  return `In ${Math.floor(seconds/60)}m ${String(seconds%60).padStart(2,'0')}s`;
}
