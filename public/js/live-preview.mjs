import { previewStatus, countdown } from './live-preview-status.mjs';
const params = new URLSearchParams(location.search);
const kind = params.get('kind');
const id = params.get('id');
const fallback = params.get('label') || (kind === 'scrape' ? 'Scrape' : 'Campaign');
const el = id => document.getElementById(id);
const img = el('stream');
let imageTimer, pollTimer, closed = false, controller, model, checkedAt = 0, engineName = 'Cloud engine', live = false;
const valid = ['campaign', 'scrape'].includes(kind) && id;
const url = kind === 'scrape' ? `/api/scrape/view/${encodeURIComponent(id)}` : `/api/campaign/cloud/${encodeURIComponent(id)}/view`;
function name(value) { el('label').textContent = value; document.title = `${value} — Live preview`; }
name(fallback);
function connect() {
  if (closed) return;
  img.src = `${url}?t=${Date.now()}`;
}
img.onload = () => {
  if (closed || model?.terminal) return;
  live = true; img.hidden = false; el('waiting').hidden = true; el('status').textContent = '● Live';
};
function waiting() { live = false; img.hidden = true; el('waiting').hidden = false; el('status').textContent = 'Browser inactive'; }
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
    model = previewStatus(data, fallback);
    name(data.live && data.liveAccount ? `${model.name} · Browser: ${data.liveAccount}` : model.name);
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
    // A stream may have ended without an error event; reconnect after an idle poll.
    if (!live) { clearTimeout(imageTimer); connect(); }
  } catch (_) {
    if (!closed) { el('engine').textContent = `${engineName} · status unavailable, retrying…`; if (!model) el('step').textContent = 'Waiting for the engine'; }
  } finally { clearTimeout(timeout); if (!closed) pollTimer = setTimeout(poll, 5000); }
}
const tick = setInterval(() => {
  el('countdown').textContent = countdown(model?.due);
  el('checked').textContent = checkedAt ? `Last checked ${Math.floor((Date.now()-checkedAt)/1000)}s ago · refreshes every 5s` : '';
}, 1000);
addEventListener('beforeunload', () => {
  closed = true; clearTimeout(imageTimer); clearTimeout(pollTimer); clearInterval(tick); controller?.abort();
  img.onload = img.onerror = null; img.removeAttribute('src');
});
if (valid) { connect(); poll(); }
else { el('status').textContent = 'Unavailable'; el('step').textContent = 'Open a preview from a campaign or scrape.'; }
