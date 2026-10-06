import { maturingPreviewActivity } from './mature-preview-picker.mjs';
import { maturingNextAction, maturingBatchDone } from './mature-profile-board.mjs';
export function previewStatus(data, fallback = 'Campaign', now = Date.now()) {
  const c = data.campaign || {};
  const state = c.status || 'unknown';
  const terminal = { done: 'Campaign complete', completed: 'Campaign complete', cancelled: 'Campaign stopped', stopped: 'Campaign stopped', failed: 'Campaign failed', needs_review: 'Needs attention', paused: 'Campaign paused' };
  const logs = (Array.isArray(data.monitorLog) ? data.monitorLog : []).map(e => ({ line: String(e.line || ''), t: Number(e.t) || 0 })).filter(e => e.line).sort((a,b) => b.t-a.t).slice(0,5);
  const due = terminal[state] ? 0 : [c.blocked_until, c.scheduled_start_at, c.resumeTaskDueAt, c.monitorTaskDueAt, c.next_check_at].map(v => v ? new Date(v).getTime() : 0).filter(t => t > now).sort((a,b) => a-b)[0] || 0;
  const progress = data.liveProgress || {};
  if (!terminal[state] && data.live && progress.step === 'between_profiles') {
    const nextProfileAt = Number(progress.nextProfileAt) || 0;
    const remaining = nextProfileAt > now;
    return { name: c.name || fallback, logs, terminal: false, transition: true,
      step: remaining ? 'Mid-batch — waiting for the next profile' : 'Mid-batch — loading the next profile',
      next: remaining ? 'The worker will start opening the next profile when this timer ends. Page loading can take a little longer.'
        : 'The scheduled pause has ended. The worker is preparing the next profile; the preview resumes automatically.',
      due: nextProfileAt, nextProfile: true };
  }
  // Profile maturing: say what the plan does next and when, in the same words
  // as the Profile Maturing tab.
  const accepting = maturingPreviewActivity({live:!!data.live, engineStatus:state, liveProgress:data.liveProgress, liveStamp:data.liveStamp}, now) === 'Accepting';
  if (c.config?.matureWarm && (!terminal[state] || accepting)) {
    const st = String(state);
    const item = { name: c.name, matureKind: c.config.matureKind || 'warm', warmSchedule: c.config.dailySchedule || null, matureTz: c.config.tz || '',
      bucket: ['pending', 'queued', 'scheduled'].includes(st) ? 'queued' : 'running', dailyWait: st === 'waiting_daily_reset', live: !!data.live, engineStatus:st, liveProgress:data.liveProgress, liveStamp:data.liveStamp,
      scheduledAt: c.scheduled_start_at || null, resumeAt: c.resumeTaskDueAt || null,
      acceptPending: Number(c.matureAcceptPending) || 0, acceptDueAt: c.matureAcceptDueAt || null, batchDoneToday: maturingBatchDone(data.monitorLog) };
    const text = maturingNextAction(item, { now });
    if (text) {
      const [head, ...rest] = text.split(' · ');
      const when = accepting ? null : item.acceptPending > 0 ? item.acceptDueAt : item.dailyWait ? item.resumeAt : item.bucket === 'queued' ? item.scheduledAt : null;
      const whenMs = when ? new Date(when).getTime() : 0;
      return { name: c.name || fallback, logs, terminal: false, step: head, due: whenMs || 0,
        next: (rest.length ? `${rest.join(' · ')}. ` : '') + (item.live ? 'The browser is shown below while it works.' : 'The browser appears here automatically when a worker opens it.') };
    }
  }
  const step = terminal[state] || (due ? 'Waiting for the next scheduled action' : data.liveProgress?.stepLabel || ({ queued: 'Waiting for a worker', scheduled: 'Scheduled', monitoring: 'Monitoring connections', sending: 'Waiting for the next account turn', running: 'Campaign running' }[state]) || 'Waiting for an engine update');
  const next = terminal[state] ? (['done','completed','cancelled','stopped'].includes(state) ? 'No further browser activity is scheduled for this run.' : 'Open the campaign to review its status before continuing.') : due ? 'The engine will retry or run its next check at the time below.' : 'The browser preview will appear automatically when a browser becomes available.';
  return { name: c.name || fallback, step, next, due, logs, terminal: !!terminal[state] };
}
export function countdown(due, now = Date.now()) {
  if (!due) return '';
  const seconds = Math.ceil((due - now)/1000);
  if (seconds <= 0) return 'Due now · waiting for the engine';
  if (seconds >= 3600) return `In ${Math.floor(seconds/3600)}h ${String(Math.floor(seconds%3600/60)).padStart(2,'0')}m`;
  return `In ${Math.floor(seconds/60)}m ${String(seconds%60).padStart(2,'0')}s`;
}
