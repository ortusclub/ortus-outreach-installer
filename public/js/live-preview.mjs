import { previewStatus, countdown, previewSessionKey } from './live-preview-status.mjs';
const params = new URLSearchParams(location.search);
const kind = params.get('kind');
const id = params.get('id');
const fallback = params.get('label') || (kind === 'scrape' ? 'Scrape' : 'Campaign');
const el = id => document.getElementById(id);
const img = el('stream');
let streamSession = '', latestData, imageTimer, pollTimer, closed = false, controller, model, checkedAt = 0, engineName = 'Cloud engine', live = false;
const valid = ['campaign', 'scrape'].includes(kind) && id;
const url = kind === 'scrape' ? `/api/scrape/view/${encodeURIComponent(id)}` : `/api/campaign/cloud/${encodeURIComponent(id)}/view`;
function name(value) { el('label').textContent = value; document.title = `${value} — Live preview`; }
name(fallback);
function connect() {
  if (closed) return;
  img.src = `${url}?t=${Date.now()}`;
}
img.onload = () => {
  if (closed || model?.terminal || latestData?.live === false) return;
  live = true; img.hidden = !!model?.transition; el('waiting').hidden = !model?.transition; el('status').textContent = model?.transition ? 'Mid-batch' : '● Live';
};
function waiting() { live = false; img.hidden = true; el('waiting').hidden = false; el('status').textContent = model?.transition ? 'Mid-batch' : 'Waiting for browser'; }
img.onerror = () => { if (closed) return; waiting(); clearTimeout(imageTimer); imageTimer = setTimeout(connect, 4000); };
async function json(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Engine unavailable');
  const data = await response.json();
  if (data.error) throw new Error('Engine unavailable');
  return data;
}
async function poll() {
  controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const target = await json('/api/engine-target', controller.signal);
    engineName = target.active === 'development' || target.engine === 'dev' ? 'Development engine' : 'Production engine';
    let data;
    if (kind === 'campaign') data = await json(`/api/campaign/cloud/${encodeURIComponent(id)}`, controller.signal);
    else {
      const result = await json('/api/scrape/jobs', controller.signal);
      const job = (Array.isArray(result) ? result : result.jobs || []).find(j => String(j.id || j.jobId) === id);
      if (!job) throw new Error('Job unavailable');
      data = { campaign: { name: job.campaignName || fallback, status: job.state }, monitorLog: [], liveProgress: { stepLabel: job.state === 'running' ? `Scraping · ${job.profiles || 0} profiles collected` : '' } };
    }
    if (closed) return;
    const sessionKey = previewSessionKey(data);
    const sessionChanged = sessionKey && sessionKey !== streamSession;
    streamSession = sessionKey;
    latestData = data;
    model = previewStatus(data, fallback);
    name(data.live && data.liveAccount ? `${model.name} · Browser: ${data.liveProgress?.accountName || data.liveAccount}` : model.name);
    checkedAt = Date.now();
    el('engine').textContent = `${engineName} · connected`;
    el('step').textContent = model.step;
    el('next').textContent = model.next;
    el('activity').replaceChildren(...(model.logs.length ? model.logs : [{line:'No recent activity reported.',t:0}]).map(log => {
      const li = document.createElement('li');
      if (log.t) { const time = document.createElement('time'); time.textContent = new Date(log.t).toLocaleTimeString(); li.append(time); }
      li.append(document.createTextNode(log.line)); return li;
    }));
    if (data.live === false || model.terminal) waiting();
    else if (model.transition) { img.hidden = true; el('waiting').hidden = false; el('status').textContent = 'Mid-batch'; }
    else if (live) { img.hidden = false; el('waiting').hidden = true; }
    // A stream may have ended without an error event; reconnect after an idle poll.
    if (sessionChanged || (!live && !model.transition && !model.terminal)) { clearTimeout(imageTimer); connect(); }
  } catch (_) {
    if (!closed) { el('engine').textContent = `${engineName} · status unavailable, retrying…`; if (!model) el('step').textContent = 'Waiting for the engine'; }
  } finally { clearTimeout(timeout); if (!closed) pollTimer = setTimeout(poll, 5000); }
}
const tick = setInterval(() => {
  if (latestData) model = previewStatus(latestData, fallback);
  const timer = model?.nextProfile
    ? model.due > Date.now() ? `Next profile starts loading ${countdown(model.due).toLowerCase()}` : 'Loading the next profile automatically…'
    : countdown(model?.due);
  el('countdown').textContent = timer;
  el('progress-note').textContent = model ? `${model.step}${timer ? ' · ' + timer : ''}` : 'Connecting to the browser…';
  if (model?.transition) { el('step').textContent = model.step; el('next').textContent = model.next; }
  el('checked').textContent = checkedAt ? `Last checked ${Math.floor((Date.now()-checkedAt)/1000)}s ago · refreshes every 5s` : '';
}, 1000);
addEventListener('beforeunload', () => {
  closed = true; clearTimeout(imageTimer); clearTimeout(pollTimer); clearInterval(tick); controller?.abort();
  img.onload = img.onerror = null; img.removeAttribute('src');
});
if (valid) { connect(); poll(); }
else { el('status').textContent = 'Unavailable'; el('step').textContent = 'Open a preview from a campaign or scrape.'; }
