const labels = { outreach: 'Outreach campaigns', maturing: 'Profile maturing', salesnav: 'Sales Navigator', connections: 'Connection DB' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => { const d = new Date(value || NaN); return Number.isNaN(d.getTime()) ? 'Not recorded' : d.toLocaleString(); };
const status = value => String(value || 'unknown').replaceAll('_', ' ');

export function createAdminPanel({ mount, openCampaign }) {
  let data = null, filter = 'all', query = '', state = 'all', timer, busy = false, generation = 0;
  const expanded = new Set();
  mount.innerHTML = `<header class="admin-heading"><div><p class="admin-eyebrow">ADMINISTRATION · TEAM ACTIVITY</p><h1>Campaign overview</h1><p>See what is running, review past activity, and open any campaign.</p></div><button type="button" class="btn btn-outline" data-action="refresh">Refresh</button></header>
    <div class="admin-message" role="status" aria-live="polite">Loading campaigns…</div>
    <div class="admin-cards"></div>
    <section class="admin-basics" aria-label="Ortus Basics scheduled campaigns"></section>
    <div class="admin-toolbar"><label>Search campaigns or people<input type="search" id="admin-search" placeholder="Campaign name or operator email"></label><label>Status<select id="admin-state"><option value="all">All activity</option><option value="running">Running now</option><option value="scheduled">Scheduled</option><option value="waiting">Queued, paused or waiting</option><option value="history">Have run</option></select></label><span class="admin-updated"></span></div>
    <div class="admin-results"></div><p class="admin-scope"></p>`;
  function render() {
    if (!data) return;
    const cats = [{ id: 'all', total: data.campaigns.length, running: data.categories.reduce((n, c) => n + c.running, 0), scheduled: data.categories.reduce((n, c) => n + c.scheduled, 0), haveRun: data.categories.reduce((n, c) => n + c.haveRun, 0) }, ...data.categories];
    mount.querySelector('.admin-cards').innerHTML = cats.map(c => `<button type="button" class="admin-card ${filter === c.id ? 'selected' : ''}" data-category="${c.id}" aria-pressed="${filter === c.id}"><span>${labels[c.id] || 'All campaigns'}</span><strong>${c.running}<small> running now</small></strong><span class="admin-scheduled-count">${c.scheduled ?? 0} scheduled</span><span>${c.haveRun} have run · ${c.total} total</span></button>`).join('');
    const basics = data.basics;
    const basicsHost = mount.querySelector('.admin-basics');
    const basicsOpen = basicsHost.querySelector('details')?.open || false;
    basicsHost.innerHTML = `<details ${basicsOpen ? 'open' : ''}><summary><span><strong>Ortus Basics</strong><small>Scheduled campaigns</small></span><span class="admin-status">${basics?.available ? `${basics.scheduled ?? 0} scheduled` : 'Not available on this Mac'}</span></summary><div class="admin-basics-content"><p>${esc(basics?.scope || 'No Ortus Basics data was found on this Mac.')}</p>${basics?.warnings?.length ? `<p class="admin-warning">${esc(basics.warnings.join(' '))}</p>` : ''}${basics?.schedules?.length ? `<table><thead><tr><th>Campaign</th><th>Operator</th><th>Next run</th><th>Where</th><th>Accounts</th></tr></thead><tbody>${basics.schedules.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.owner || 'Not recorded')}</td><td>${esc(r.scheduledAt ? date(r.scheduledAt) : r.scheduleLabel)}<small>${esc(r.scheduleLabel)}</small></td><td>${r.source === 'cloud' ? 'Cloud engine' : 'Basics on this Mac'}</td><td>${r.accounts}</td></tr>`).join('')}</tbody></table>` : '<p>No scheduled Basics campaigns were found in the available records.</p>'}</div></details>`;
    const matches = data.campaigns.filter(c => (filter === 'all' || c.category === filter)
      && (!query || `${c.name} ${c.owner} ${c.runs.map(r => r.owner).join(' ')}`.toLowerCase().includes(query))
      && (state === 'all' || (state === 'running' && c.running) || (state === 'scheduled' && c.scheduled) || (state === 'waiting' && c.waiting) || (state === 'history' && c.hasRun)));
    const logs = new Map([...mount.querySelectorAll('.admin-campaign')].map(el => [el.dataset.id, el.querySelector('.admin-log')]).filter(([, el]) => el && !el.hidden).map(([id, el]) => [id, el.textContent]));
    mount.querySelector('.admin-results').innerHTML = matches.length ? matches.map(c => `<details class="admin-campaign" data-id="${esc(c.id)}" ${expanded.has(c.id) ? 'open' : ''}>
      <summary><span class="admin-campaign-title"><strong>${esc(c.name)}</strong><small>${esc(labels[c.category])} · ${esc(c.owner || 'Operator not recorded')}</small></span><span class="admin-status ${c.running ? 'running' : ''}">${c.running ? (c.scheduled ? 'Running · scheduled' : 'Running') : c.scheduled ? 'Scheduled' : c.waiting ? 'Queued / paused / waiting' : 'Past activity'}</span><span class="admin-run-count">${c.runs.length} ${c.runs.length === 1 ? 'run' : 'runs'}<small>${c.finishedRuns} finished</small></span></summary>
      <div class="admin-run-history"><table><caption>Schedules and run history for ${esc(c.name)}</caption><thead><tr><th>Started / scheduled</th><th>Operator</th><th>Status</th><th>Details</th><th>Actions</th></tr></thead><tbody>${c.runs.map((r, index) => `<tr><td>${r.scheduled ? `<strong>${esc(r.scheduledAt ? date(r.scheduledAt) : r.scheduleLabel)}</strong><small>${esc(r.scheduleLabel)}</small>` : esc(date(r.startedAt || r.createdAt))}${r.finishedAt ? `<small>Ended ${esc(date(r.finishedAt))}</small>` : ''}</td><td>${esc(r.owner || 'Not recorded')}</td><td>${esc(status(r.status))}<small>${esc(r.source === 'cloud' ? 'Cloud engine' : r.source === 'scrape' ? 'Sales Navigator engine' : 'This Mac')}</small></td><td>${r.accounts != null ? `${r.accounts} accounts` : '—'}${r.searches != null ? `<small>${r.searches} searches</small>` : ''}${r.processed != null ? `<small>${r.processed} processed</small>` : ''}</td><td><div class="admin-actions"><button class="btn btn-outline" type="button" data-open="${index}" data-campaign="${esc(c.id)}">${r.source === 'connections' ? 'Open Connection DB' : r.source === 'queue' ? 'Open queue' : 'Open campaign'}</button>${['cloud', 'scrape', 'history', 'connections'].includes(r.source) ? `<button class="btn btn-outline" type="button" data-history="${index}" data-campaign="${esc(c.id)}">View log</button>` : ''}</div></td></tr>`).join('')}</tbody></table><div class="admin-log" hidden></div></div></details>`).join('') : '<div class="admin-empty">No campaigns match these filters.</div>';
    for (const details of mount.querySelectorAll('.admin-campaign')) {
      if (logs.has(details.dataset.id)) { const box = details.querySelector('.admin-log'); box.hidden = false; box.textContent = logs.get(details.dataset.id); }
    }
    mount.querySelector('.admin-updated').textContent = `Updated ${date(data.updatedAt)}`;
    mount.querySelector('.admin-scope').textContent = data.scope;
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    const token = generation;
    const message = mount.querySelector('.admin-message');
    message.textContent = data ? 'Refreshing…' : 'Loading campaigns…';
    try {
      const response = await fetch('/api/admin/campaigns', { signal: AbortSignal.timeout(90000) });
      if (!response.ok) throw new Error(response.status === 403 ? 'This section is available to administrators only.' : 'Could not load campaigns. Try Refresh.');
      const result = await response.json();
      if (token !== generation) return;
      data = result; render();
      message.textContent = result.warnings?.length ? result.warnings.join(' ') : 'Team overview · refreshes every 30 seconds';
      message.classList.toggle('admin-warning', !!result.warnings?.length);
    } catch (error) { if (token === generation) { message.textContent = error.message + (data ? ' Previously loaded data remains below.' : ''); message.classList.add('admin-warning'); } }
    finally { busy = false; }
  }
  mount.addEventListener('toggle', event => {
    const details = event.target.closest?.('.admin-campaign');
    if (details) details.open ? expanded.add(details.dataset.id) : expanded.delete(details.dataset.id);
  }, true);
  mount.querySelector('#admin-search').addEventListener('input', event => { query = event.target.value.trim().toLowerCase(); render(); });
  mount.querySelector('#admin-state').addEventListener('change', event => { state = event.target.value; render(); });
  mount.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.action === 'refresh') return refresh();
    if (button.dataset.category) { filter = button.dataset.category; render(); return; }
    const c = data?.campaigns.find(c => c.id === button.dataset.campaign);
    if (!c) return;
    const run = c.runs[Number(button.dataset.open ?? button.dataset.history)];
    button.disabled = true;
    try {
      if (button.dataset.open != null) await openCampaign(c, run);
      else {
        const box = button.closest('.admin-campaign').querySelector('.admin-log');
        box.hidden = false; box.textContent = 'Loading log…';
        const path = run.source === 'cloud' ? `/api/campaign/cloud/${encodeURIComponent(run.id)}` : run.source === 'scrape' ? (run.runId ? `/api/admin/scrapes/${encodeURIComponent(run.campaignId)}/runs/${encodeURIComponent(run.runId)}` : `/api/scrape/campaigns/${encodeURIComponent(run.campaignId)}/logs`) : run.source === 'history' ? `/api/history/${run.historyIndex}/log` : `/api/admin/connections/${encodeURIComponent(run.id)}`;
        const response = await fetch(path, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw Error('Could not load this run’s log. Please try again.');
        const result = await response.json();
        const lines = result.monitorLog || result.lines || result.log || result.logs || [];
        box.textContent = Array.isArray(lines) && lines.length ? lines.map(l => typeof l === 'string' ? l : `${l.ts || l.time || l.at || ''} ${l.message || l.text || l.line || JSON.stringify(l)}`).join('\n') : 'No retained log entries for this run.';
      }
    } catch (error) { mount.querySelector('.admin-message').textContent = error.message; }
    finally { button.disabled = false; }
  });
  return {
    start() { clearInterval(timer); refresh(); timer = setInterval(() => { if (!document.hidden) refresh(); }, 30000); },
    stop() { clearInterval(timer); generation++; },
  };
}
