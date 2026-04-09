/* global fetch */

let selectedProfileIds = [];
let selectedProfileNames = {};
let allProfilesData = [];
let pollInterval = null;

// ─────────────────────────────────────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────────────────────────────────────
async function loadProfiles() {
  const loading = document.getElementById('profiles-loading');
  const grid = document.getElementById('profiles-grid');
  loading.textContent = 'Loading profiles…';
  loading.classList.remove('hidden');
  grid.classList.add('hidden');

  try {
    const res = await fetch('/api/profiles');
    const profiles = await res.json();
    if (profiles.error) { loading.textContent = `Error: ${profiles.error}`; return; }
    allProfilesData = profiles;
    loading.classList.add('hidden');
    grid.classList.remove('hidden');
    renderProfiles(profiles);
  } catch (err) {
    loading.textContent = `Failed: ${err.message}`;
  }
}

function renderProfiles(profiles) {
  const grid = document.getElementById('profiles-grid');
  grid.innerHTML = '';
  profiles.forEach((p) => {
    const item = document.createElement('label');
    item.className = 'profile-item' + (selectedProfileIds.includes(p.id) ? ' selected' : '');
    item.dataset.profileId = p.id;
    item.innerHTML = `
      <input type="checkbox" value="${p.id}" ${selectedProfileIds.includes(p.id) ? 'checked' : ''} />
      <div>
        <div class="name">${escHtml(p.name)}</div>
        <div class="id">${p.id.substring(0, 12)}…</div>
      </div>
    `;
    const cb = item.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!selectedProfileIds.includes(p.id)) {
          selectedProfileIds.push(p.id);
          selectedProfileNames[p.id] = p.name;
        }
        item.classList.add('selected');
      } else {
        selectedProfileIds = selectedProfileIds.filter(id => id !== p.id);
        delete selectedProfileNames[p.id];
        item.classList.remove('selected');
      }
      renderSelectedPanel();
    });
    grid.appendChild(item);
  });
  renderSelectedPanel();
}

function renderSelectedPanel() {
  const panel = document.getElementById('selected-panel');
  const list = document.getElementById('selected-list');
  const count = document.getElementById('profiles-count');

  if (selectedProfileIds.length === 0) {
    panel.classList.add('hidden');
    if (count) count.textContent = `0 selected / ${allProfilesData.length} total`;
    return;
  }

  panel.classList.remove('hidden');
  if (count) count.textContent = `${selectedProfileIds.length} selected / ${allProfilesData.length} total`;

  list.innerHTML = selectedProfileIds.map((id, i) => {
    const name = selectedProfileNames[id] || id;
    return `<div class="selected-item">
      <span class="order">${i + 1}</span>
      <span class="name">${escHtml(name)}</span>
      <button class="btn-remove" onclick="removeProfile('${id}')" title="Remove">&times;</button>
    </div>`;
  }).join('');
}

function removeProfile(id) {
  selectedProfileIds = selectedProfileIds.filter(pid => pid !== id);
  delete selectedProfileNames[id];
  const cb = document.querySelector(`#profiles-grid input[value="${id}"]`);
  if (cb) { cb.checked = false; cb.closest('.profile-item')?.classList.remove('selected'); }
  renderSelectedPanel();
}

function filterProfiles() {
  const query = (document.getElementById('profile-search').value || '').toLowerCase().trim();
  const filtered = query
    ? allProfilesData.filter(p => p.name.toLowerCase().includes(query) || p.id.includes(query))
    : allProfilesData;
  renderProfiles(filtered);
}

function selectAllVisible() {
  document.querySelectorAll('#profiles-grid input[type="checkbox"]').forEach(cb => {
    if (!cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
    }
  });
}

function deselectAll() {
  selectedProfileIds = [];
  selectedProfileNames = {};
  document.querySelectorAll('#profiles-grid input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
    cb.closest('.profile-item')?.classList.remove('selected');
  });
  renderSelectedPanel();
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode-based template visibility
// ─────────────────────────────────────────────────────────────────────────────
function onModeChange() {
  const mode = document.getElementById('campaign-mode').value;
  const connect = document.getElementById('tpl-connect-section');
  const message = document.getElementById('tpl-message-section');
  const inmail = document.getElementById('tpl-inmail-section');
  const openToggle = document.getElementById('open-profile-toggle');

  connect.style.display = 'none';
  message.style.display = 'none';
  inmail.style.display = 'none';
  openToggle.style.display = 'none';

  if (mode === 'connect_only') {
    connect.style.display = '';
    openToggle.style.display = '';
  } else if (mode === 'message_only') {
    message.style.display = '';
  } else if (mode === 'connect_and_message') {
    connect.style.display = '';
    message.style.display = '';
    openToggle.style.display = '';
  } else if (mode === 'inmail_only') {
    inmail.style.display = '';
  } else if (mode === 'auto') {
    connect.style.display = '';
    message.style.display = '';
    inmail.style.display = '';
    openToggle.style.display = '';
  }

  // Show message template when open profile toggle is checked
  updateOpenProfileVisibility();
}

function updateOpenProfileVisibility() {
  const cb = document.getElementById('open-profile-msg');
  const message = document.getElementById('tpl-message-section');
  const mode = document.getElementById('campaign-mode').value;
  if (cb && cb.checked && (mode === 'connect_only' || mode === 'auto' || mode === 'connect_and_message')) {
    message.style.display = '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet preview
// ─────────────────────────────────────────────────────────────────────────────
async function previewSheet() {
  const url = document.getElementById('sheet-url').value.trim();
  const preview = document.getElementById('sheet-preview');
  if (!url) { alert('Enter a Google Sheet URL first.'); return; }
  preview.classList.remove('hidden');
  preview.innerHTML = 'Loading…';
  try {
    const res = await fetch(`/api/sheet/preview?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (data.error) { preview.innerHTML = `<p style="color:#f85149">Error: ${escHtml(data.error)}</p>`; return; }
    let html = `<p style="color:#8b949e; font-size:0.8rem; margin-bottom:8px">${data.totalRows} row(s)</p>`;
    if (data.preview.length > 0) {
      html += '<table class="preview-table"><thead><tr>';
      data.columns.forEach(col => { html += `<th>${escHtml(col)}</th>`; });
      html += '</tr></thead><tbody>';
      data.preview.forEach(row => {
        html += '<tr>';
        data.columns.forEach(col => { html += `<td>${escHtml(row[col] || '')}</td>`; });
        html += '</tr>';
      });
      html += '</tbody></table>';
    }
    preview.innerHTML = html;
  } catch (err) {
    preview.innerHTML = `<p style="color:#f85149">${escHtml(err.message)}</p>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign control
// ─────────────────────────────────────────────────────────────────────────────
async function startCampaign() {
  if (selectedProfileIds.length === 0) { alert('Select at least one GoLogin profile.'); return; }
  const sheetUrl = document.getElementById('sheet-url').value.trim();
  if (!sheetUrl) { alert('Enter a Google Sheet URL.'); return; }
  const dailyLimit = parseInt(document.getElementById('daily-limit').value, 10);
  if (!dailyLimit || dailyLimit < 1) { alert('Limit must be at least 1.'); return; }

  const templates = {
    connectionNote: document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
  };
  const mode = document.getElementById('campaign-mode').value;

  // Show account queue
  renderAccountQueue(selectedProfileIds.map(id => selectedProfileNames[id] || id), null);

  try {
    const res = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds: selectedProfileIds, sheetUrl, templates, dailyLimit, mode, messageOpenProfiles: !!document.getElementById('open-profile-msg')?.checked }),
    });
    const data = await res.json();
    if (data.error) { alert(`Error: ${data.error}`); return; }
    if (!data.ok) { alert(data.message || 'Could not start campaign.'); return; }
    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-stop').disabled = false;
    startPolling();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

async function stopCampaign() {
  try { await fetch('/api/campaign/stop', { method: 'POST' }); } catch { /* */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Account queue display
// ─────────────────────────────────────────────────────────────────────────────
function renderAccountQueue(names, currentName) {
  const el = document.getElementById('account-queue');
  if (!names || names.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = names.map((name, i) => {
    let cls = 'queue-item';
    if (currentName && name === currentName) cls += ' active';
    else if (currentName && names.indexOf(currentName) > i) cls += ' done';
    return `<div class="${cls}"><span class="num">${i + 1}</span><span class="name">${escHtml(name)}</span></div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Status polling
// ─────────────────────────────────────────────────────────────────────────────
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollStatus, 2000);
  pollStatus();
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
}

async function pollStatus() {
  try {
    const res = await fetch('/api/campaign/status');
    const s = await res.json();

    // Detect campaign completion and refresh history
    if (wasRunning && !s.running) {
      fetchHistory();
    }
    wasRunning = s.running;

    const runEl = document.getElementById('st-running');
    if (s.running) {
      runEl.textContent = 'Running';
      runEl.className = 'value running';
    } else {
      runEl.textContent = 'Idle';
      runEl.className = 'value stopped';
      document.getElementById('btn-start').disabled = false;
      document.getElementById('btn-stop').disabled = true;
      if (s.logs?.length > 0 && !s.running) stopPolling();
    }

    document.getElementById('st-profile').textContent = s.currentProfile || '—';

    const modeLabels = {
      auto: 'Auto', connect_only: 'Connect Only', connect_and_message: 'Connect + Msg',
      message_only: 'Message Only', inmail_only: 'InMail Only', check_status: 'Check Status',
    };
    document.getElementById('st-mode').textContent = modeLabels[s.mode] || s.mode || '—';

    document.getElementById('st-today').textContent = s.processedToday;
    document.getElementById('st-total').textContent = s.totalTargets;
    document.getElementById('st-errors').textContent = (s.errors || []).length;

    const pct = s.totalTargets > 0 ? Math.min(100, Math.round((s.processedToday / s.totalTargets) * 100)) : 0;
    document.getElementById('st-bar').style.width = pct + '%';

    // Update account queue if we have profile names
    if (s.profileNames && s.profileNames.length > 0) {
      renderAccountQueue(s.profileNames, s.currentProfile);
    }

    if (s.logs?.length > 0) {
      const panel = document.getElementById('log-panel');
      panel.innerHTML = s.logs.map(line => {
        let cls = '';
        if (line.includes('✓') || line.includes('connection_sent') || line.includes('message_sent') || line.includes('status_accepted')) cls = 'success';
        else if (line.includes('✗') || line.includes('Error') || line.includes('FAILED')) cls = 'error';
        else if (line.includes('⚠') || line.includes('SKIPPED')) cls = 'warn';
        else if (line.includes('===') || line.includes('▶') || line.includes('■')) cls = 'info';
        return `<div class="entry ${cls}">${escHtml(line)}</div>`;
      }).join('');
      panel.scrollTop = panel.scrollHeight;
    }
  } catch { /* */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTemplateList() {
  try {
    const res = await fetch('/api/templates');
    const data = await res.json();
    const sel = document.getElementById('tpl-select');
    // Preserve the default option, clear the rest
    sel.innerHTML = '<option value="">-- Select a template --</option>';
    Object.keys(data).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name; // textContent is XSS-safe
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to fetch templates:', err);
  }
}

async function loadSelectedTemplate() {
  const sel = document.getElementById('tpl-select');
  const name = sel.value;
  if (!name) { alert('Select a template first.'); return; }
  try {
    const res = await fetch('/api/templates');
    const data = await res.json();
    const tpl = data[name];
    if (!tpl) { alert('Template not found.'); return; }
    document.getElementById('tpl-note').value = tpl.connectionNote || '';
    document.getElementById('tpl-followup').value = tpl.followUp1 || '';
    document.getElementById('tpl-inmail-subject').value = tpl.inmailSubject || '';
    document.getElementById('tpl-inmail-body').value = tpl.inmailBody || '';
  } catch (err) {
    alert('Failed to load template: ' + err.message);
  }
}

async function saveCurrentTemplate() {
  const name = prompt('Template name:');
  if (!name || !name.trim()) return;
  const templates = {
    connectionNote: document.getElementById('tpl-note').value,
    followUp1: document.getElementById('tpl-followup').value,
    inmailSubject: document.getElementById('tpl-inmail-subject').value,
    inmailBody: document.getElementById('tpl-inmail-body').value,
  };
  try {
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), templates }),
    });
    const data = await res.json();
    if (data.saved) {
      await fetchTemplateList();
      document.getElementById('tpl-select').value = name.trim();
    } else {
      alert('Failed to save template.');
    }
  } catch (err) {
    alert('Failed to save template: ' + err.message);
  }
}

async function deleteSelectedTemplate() {
  const sel = document.getElementById('tpl-select');
  const name = sel.value;
  if (!name) { alert('Select a template first.'); return; }
  if (!confirm('Delete template "' + name + '"?')) return;
  try {
    const res = await fetch('/api/templates/' + encodeURIComponent(name), { method: 'DELETE' });
    const data = await res.json();
    if (data.deleted) {
      await fetchTemplateList();
    } else {
      alert('Failed to delete template.');
    }
  } catch (err) {
    alert('Failed to delete template: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign History
// ─────────────────────────────────────────────────────────────────────────────
async function fetchHistory() {
  const panel = document.getElementById('history-panel');
  if (!panel) return;
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      panel.innerHTML = '<p class="empty-state">No campaigns yet.</p>';
      return;
    }

    const modeLabels = {
      auto: 'Auto', connect_only: 'Connect Only', connect_and_message: 'Connect + Msg',
      message_only: 'Message Only', inmail_only: 'InMail Only', check_status: 'Check Status',
    };

    // Sort newest first
    data.sort((a, b) => new Date(b.startedAt || b.date) - new Date(a.startedAt || a.date));

    let html = '<table class="history-table"><thead><tr>';
    html += '<th>Date</th><th>Mode</th><th>Profiles</th><th>Success</th><th>Errors</th><th>Duration</th>';
    html += '</tr></thead><tbody>';

    data.forEach((c, idx) => {
      const dt = c.startedAt || c.date || '';
      const dateStr = dt ? new Date(dt).toISOString().replace('T', ' ').substring(0, 16) : '--';
      const modeLabel = modeLabels[c.mode] || escHtml(c.mode || '--');
      const profiles = (c.profileNames || c.profiles || []).join(', ');
      const profileDisplay = profiles.length > 30 ? escHtml(profiles.substring(0, 27)) + '...' : escHtml(profiles);
      const success = c.successCount != null ? c.successCount : (c.totalProcessed || 0);
      const errors = c.errorCount != null ? c.errorCount : 0;

      // Duration calculation
      let durationStr = '--';
      if (c.duration != null) {
        durationStr = c.duration >= 60 ? Math.round(c.duration / 60) + 'm' : c.duration + 's';
      } else if (c.startedAt && c.endedAt) {
        const mins = Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 60000);
        durationStr = mins + 'm';
      }

      // Summary row
      html += '<tr data-idx="' + idx + '">';
      html += '<td>' + escHtml(dateStr) + '</td>';
      html += '<td>' + modeLabel + '</td>';
      html += '<td>' + profileDisplay + '</td>';
      html += '<td class="success-count">' + success + '</td>';
      html += '<td class="error-count">' + errors + '</td>';
      html += '<td>' + escHtml(durationStr) + '</td>';
      html += '</tr>';

      // Detail row (hidden by default)
      const tplNote = (c.templates && c.templates.connectionNote) || '';
      const tplDisplay = tplNote.length > 50 ? escHtml(tplNote.substring(0, 47)) + '...' : escHtml(tplNote);
      html += '<tr class="history-detail" data-detail-idx="' + idx + '">';
      html += '<td colspan="6"><dl>';
      html += '<dt>Templates</dt><dd>' + (tplDisplay || 'None') + '</dd>';
      html += '<dt>Daily Limit</dt><dd>' + escHtml(String(c.dailyLimit || '--')) + '</dd>';
      html += '<dt>Total Processed</dt><dd>' + escHtml(String(c.totalProcessed || 0)) + '</dd>';
      html += '</dl></td></tr>';
    });

    html += '</tbody></table>';
    panel.innerHTML = html;

    // Add click handlers for expanding detail rows
    panel.querySelectorAll('tr[data-idx]').forEach(tr => {
      tr.onclick = function() {
        const idx = this.getAttribute('data-idx');
        const detail = panel.querySelector('tr[data-detail-idx="' + idx + '"]');
        if (detail) detail.classList.toggle('expanded');
      };
    });
  } catch (err) {
    panel.innerHTML = '<p class="empty-state">Failed to load history.</p>';
  }
}

function downloadCsv() {
  const a = document.createElement('a');
  a.href = '/api/export/csv';
  a.download = 'campaign-export.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

let wasRunning = false;

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
loadProfiles();
onModeChange();
pollStatus();
fetchTemplateList();
fetchHistory();

// Open Profile toggle listener
document.getElementById('open-profile-msg')?.addEventListener('change', () => {
  onModeChange();
});

document.addEventListener('click', (e) => {
  const tag = e.target.closest('.placeholder-tags .tag');
  if (!tag) return;
  const targetId = tag.closest('.placeholder-tags')?.dataset.target;
  if (!targetId) return;
  const field = document.getElementById(targetId);
  if (!field) return;
  const val = tag.dataset.val;
  if (typeof field.selectionStart === 'number') {
    const start = field.selectionStart;
    field.value = field.value.substring(0, start) + val + field.value.substring(field.selectionEnd);
    field.selectionStart = field.selectionEnd = start + val.length;
  } else {
    field.value += val;
  }
  field.focus();
});
