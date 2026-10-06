// Queue observations only: never claim a worker has started or promise a start time.
export function createScrapeWaitLog() {
  const scopes = new Map();
  return (jobs = [], now = Date.now()) => {
    const key = jobs.map(j => j.id || j.jobId || `${j.runId}:${j.searchUrl}`).sort().join('|');
    if (!key) return [];
    let state = scopes.get(key);
    if (!state) { state = {since:now,tick:-1,lines:[]}; scopes.set(key,state); }
    if (scopes.size > 20) scopes.delete(scopes.keys().next().value);
    const queued = jobs.filter(j => j.state === 'queued');
    if (!queued.length || jobs.some(j => j.state === 'running')) return state.lines;
    const created = queued.map(j => typeof j.createdAt === 'number' ? j.createdAt : Date.parse(j.createdAt)).filter(t=>Number.isFinite(t)&&t>0&&t<=now);
    const since = created.length ? Math.min(...created) : state.since;
    const tick = Math.floor((now-state.since)/30000);
    if (tick !== state.tick) {
      state.tick = tick;
      const seconds = Math.max(0,Math.floor((now-since)/1000));
      const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds/60)}m ${String(seconds%60).padStart(2,'0')}s`;
      state.lines.push({ts:now,message:`⏳ ${state.lines.length ? 'Still waiting' : 'Waiting'} for a worker and an available selected account — ${duration} in the queue. Starts automatically when both are available.`});
      state.lines = state.lines.slice(-15);
    }
    return state.lines;
  };
}
